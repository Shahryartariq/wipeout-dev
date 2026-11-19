// Wipeout lock finder.
// Enumerates every open handle on the system, keeps the ones that point inside
// the target folder, and reports which processes own them.
// Written for C# 5 so Windows PowerShell 5.1's Add-Type can compile it.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WipeoutLockInfo
{
    public int Pid;
    public int Count;          // open handles inside the folder(s)
    public bool HoldsFolder;   // at least one of them is a directory (e.g. a terminal's working folder)
    public string[] Samples;   // a few of the held paths
    public int ModuleCount;    // DLLs / native add-ons loaded from inside the folder(s)
    public string[] ModuleSamples;
    public int[] Targets;      // which of the requested folders this process holds
}

public static class WipeoutLocks
{
    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder buffer, uint length, uint flags);

    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool EnumProcessModulesEx(IntPtr process, [Out] IntPtr[] modules, int cb, out int needed, uint filter);

    [DllImport("psapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetModuleFileNameExW(IntPtr process, IntPtr module, StringBuilder name, int size);

    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint LIST_MODULES_ALL = 0x03;

    private const int SystemExtendedHandleInformation = 64;
    private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
    private const uint PROCESS_DUP_HANDLE = 0x0040;
    private const uint DUPLICATE_SAME_ACCESS = 0x0002;
    private const uint FILE_TYPE_DISK = 0x0001;
    private const uint FILE_SHARE_ALL = 0x7;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    // Handles granted with these access masks are very often synchronous named
    // pipes, which can hang any query made on them. Skip them outright.
    private static readonly uint[] RiskyAccessMasks = new uint[] { 0x0012019f, 0x001a019f, 0x00120189, 0x00100000 };

    private struct Entry
    {
        public int Pid;
        public IntPtr Handle;
        public uint Access;
    }

    private class WorkerState
    {
        public volatile bool Abandoned;
    }

    private class Job
    {
        public Entry[] Items;
        public int Next;
        public int Current = -1;
        public int StartedAt;
        public bool Done;
        public Dictionary<int, IntPtr> Processes;
        public string[] Targets;
        public Dictionary<int, WipeoutLockInfo> Results = new Dictionary<int, WipeoutLockInfo>();
        public int MaxSamples;
    }

    public static WipeoutLockInfo[] Find(string target, int maxSamples)
    {
        return FindMany(new string[] { target }, maxSamples);
    }

    public static WipeoutLockInfo[] FindMany(string[] targets, int maxSamples)
    {
        string[] normalized = new string[targets.Length];
        for (int t = 0; t < targets.Length; t++) normalized[t] = Canonical(targets[t]);
        int self = System.Diagnostics.Process.GetCurrentProcess().Id;

        int fileTypeIndex;
        List<Entry> fileHandles = SnapshotFileHandles(self, out fileTypeIndex);

        // Open each owning process once.
        Dictionary<int, IntPtr> processes = new Dictionary<int, IntPtr>();
        foreach (Entry e in fileHandles)
        {
            if (processes.ContainsKey(e.Pid)) continue;
            IntPtr p = OpenProcess(PROCESS_DUP_HANDLE, false, e.Pid);
            processes[e.Pid] = p; // IntPtr.Zero when access is denied
        }

        List<Entry> usable = new List<Entry>();
        foreach (Entry e in fileHandles)
        {
            if (processes[e.Pid] != IntPtr.Zero) usable.Add(e);
        }

        Job job = new Job();
        job.Items = usable.ToArray();
        job.Processes = processes;
        job.Targets = normalized;
        job.MaxSamples = maxSamples;

        // One worker thread walks the handles. If it gets stuck on a single
        // handle for too long, abandon it and continue on a fresh thread.
        WorkerState state = StartWorker(job);
        int begin = Environment.TickCount;
        while (true)
        {
            Thread.Sleep(15);
            lock (job)
            {
                if (job.Done) break;
                if (job.Current >= 0 && unchecked(Environment.TickCount - job.StartedAt) > 300)
                {
                    state.Abandoned = true;
                    job.Current = -1;
                    state = StartWorker(job);
                }
            }
            if (unchecked(Environment.TickCount - begin) > 30000)
            {
                state.Abandoned = true;
                break;
            }
        }

        foreach (IntPtr p in processes.Values)
        {
            if (p != IntPtr.Zero) CloseHandle(p);
        }

        Dictionary<int, WipeoutLockInfo> results;
        lock (job) { results = new Dictionary<int, WipeoutLockInfo>(job.Results); }

        // DLLs and native add-ons (.node files) are mapped into memory and never
        // show up as handles, so check every process's loaded modules too.
        try { AddModuleHits(normalized, self, maxSamples, results); } catch { }

        List<WipeoutLockInfo> list = new List<WipeoutLockInfo>(results.Values);
        foreach (WipeoutLockInfo i in list)
        {
            if (i.Samples == null) i.Samples = new string[0];
            if (i.ModuleSamples == null) i.ModuleSamples = new string[0];
            if (i.Targets == null) i.Targets = new int[0];
        }
        return list.ToArray();
    }

    private static void AddModuleHits(string[] targets, int self, int maxSamples, Dictionary<int, WipeoutLockInfo> results)
    {
        StringBuilder sb = new StringBuilder(4096);
        foreach (System.Diagnostics.Process proc in System.Diagnostics.Process.GetProcesses())
        {
            int pid = proc.Id;
            proc.Dispose();
            if (pid == self || pid == 0 || pid == 4) continue;
            IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
            if (h == IntPtr.Zero) continue;
            try
            {
                IntPtr[] mods = new IntPtr[512];
                int needed;
                if (!EnumProcessModulesEx(h, mods, mods.Length * IntPtr.Size, out needed, LIST_MODULES_ALL)) continue;
                int count = needed / IntPtr.Size;
                if (count > mods.Length)
                {
                    mods = new IntPtr[count];
                    if (!EnumProcessModulesEx(h, mods, mods.Length * IntPtr.Size, out needed, LIST_MODULES_ALL)) continue;
                    count = Math.Min(count, needed / IntPtr.Size);
                }
                for (int m = 0; m < count; m++)
                {
                    sb.Length = 0;
                    uint len = GetModuleFileNameExW(h, mods[m], sb, sb.Capacity);
                    if (len == 0) continue;
                    string path = StripPrefix(sb.ToString());
                    int t = MatchTarget(path, targets);
                    if (t < 0) continue;
                    WipeoutLockInfo info = GetOrAdd(results, pid);
                    info.ModuleCount++;
                    info.Targets = AddUnique(info.Targets, t);
                    if (info.ModuleSamples.Length < maxSamples) info.ModuleSamples = Append(info.ModuleSamples, path);
                }
            }
            finally
            {
                CloseHandle(h);
            }
        }
    }

    private static WipeoutLockInfo GetOrAdd(Dictionary<int, WipeoutLockInfo> results, int pid)
    {
        WipeoutLockInfo info;
        if (!results.TryGetValue(pid, out info))
        {
            info = new WipeoutLockInfo();
            info.Pid = pid;
            info.Samples = new string[0];
            info.ModuleSamples = new string[0];
            info.Targets = new int[0];
            results[pid] = info;
        }
        if (info.ModuleSamples == null) info.ModuleSamples = new string[0];
        if (info.Targets == null) info.Targets = new int[0];
        if (info.Samples == null) info.Samples = new string[0];
        return info;
    }

    private static string[] Append(string[] arr, string v)
    {
        string[] grown = new string[arr.Length + 1];
        Array.Copy(arr, grown, arr.Length);
        grown[arr.Length] = v;
        return grown;
    }

    private static int[] AddUnique(int[] arr, int v)
    {
        if (Array.IndexOf(arr, v) >= 0) return arr;
        int[] grown = new int[arr.Length + 1];
        Array.Copy(arr, grown, arr.Length);
        grown[arr.Length] = v;
        return grown;
    }

    private static int MatchTarget(string path, string[] targets)
    {
        for (int t = 0; t < targets.Length; t++)
        {
            if (IsInside(path, targets[t])) return t;
        }
        return -1;
    }

    private static WorkerState StartWorker(Job job)
    {
        WorkerState state = new WorkerState();
        Thread t = new Thread(delegate () { Work(job, state); });
        t.IsBackground = true;
        t.Start();
        return state;
    }

    private static void Work(Job job, WorkerState state)
    {
        IntPtr me = GetCurrentProcess();
        StringBuilder sb = new StringBuilder(4096);
        while (true)
        {
            int i;
            lock (job)
            {
                if (state.Abandoned) return;
                i = job.Next++;
                if (i >= job.Items.Length)
                {
                    job.Done = true;
                    job.Current = -1;
                    return;
                }
                job.Current = i;
                job.StartedAt = Environment.TickCount;
            }

            Entry e = job.Items[i];
            string path = null;
            IntPtr dup;
            if (DuplicateHandle(job.Processes[e.Pid], e.Handle, me, out dup, 0, false, DUPLICATE_SAME_ACCESS))
            {
                try
                {
                    if (GetFileType(dup) == FILE_TYPE_DISK)
                    {
                        sb.Length = 0;
                        uint len = GetFinalPathNameByHandleW(dup, sb, (uint)sb.Capacity, 0);
                        if (len > 0 && len < sb.Capacity) path = StripPrefix(sb.ToString());
                    }
                }
                finally
                {
                    CloseHandle(dup);
                }
            }

            lock (job)
            {
                if (state.Abandoned) return;
                job.Current = -1;
                int t = path == null ? -1 : MatchTarget(path, job.Targets);
                if (t >= 0)
                {
                    WipeoutLockInfo info = GetOrAdd(job.Results, e.Pid);
                    info.Count++;
                    info.Targets = AddUnique(info.Targets, t);
                    bool isDir = false;
                    try { isDir = Directory.Exists(path); } catch { }
                    if (isDir) info.HoldsFolder = true;
                    if (info.Samples.Length < job.MaxSamples) info.Samples = Append(info.Samples, path);
                }
            }
        }
    }

    private static List<Entry> SnapshotFileHandles(int self, out int fileTypeIndex)
    {
        // Open a temp file so we can learn which object-type index means "File"
        // on this machine (it differs between Windows builds).
        string probePath = Path.GetTempFileName();
        List<Entry> result = new List<Entry>();
        fileTypeIndex = -1;
        try
        {
            using (FileStream probe = new FileStream(probePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                IntPtr probeHandle = probe.SafeFileHandle.DangerousGetHandle();
                IntPtr buffer = IntPtr.Zero;
                int size = 16 * 1024 * 1024;
                try
                {
                    while (true)
                    {
                        buffer = Marshal.AllocHGlobal(size);
                        int needed;
                        int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, size, out needed);
                        if (status == STATUS_INFO_LENGTH_MISMATCH)
                        {
                            Marshal.FreeHGlobal(buffer);
                            buffer = IntPtr.Zero;
                            size = Math.Max(size * 2, needed + 1024 * 1024);
                            if (size > 512 * 1024 * 1024) throw new Exception("Handle table is too large to read.");
                            continue;
                        }
                        if (status != 0) throw new Win32Exception("NtQuerySystemInformation failed: 0x" + status.ToString("X8"));
                        break;
                    }

                    int P = IntPtr.Size;
                    long count = Marshal.ReadIntPtr(buffer).ToInt64();
                    int entrySize = 3 * P + 16;
                    int offPid = P, offHandle = 2 * P, offAccess = 3 * P, offType = 3 * P + 6;
                    long baseAddr = buffer.ToInt64() + 2 * P;

                    // First pass: find the type index of our probe handle.
                    for (long i = 0; i < count; i++)
                    {
                        IntPtr row = new IntPtr(baseAddr + i * entrySize);
                        int pid = (int)Marshal.ReadIntPtr(row, offPid).ToInt64();
                        if (pid != self) continue;
                        IntPtr h = Marshal.ReadIntPtr(row, offHandle);
                        if (h == probeHandle)
                        {
                            fileTypeIndex = (ushort)Marshal.ReadInt16(row, offType);
                            break;
                        }
                    }
                    if (fileTypeIndex < 0) throw new Exception("Could not identify the File handle type.");

                    // Second pass: keep file handles from other processes.
                    for (long i = 0; i < count; i++)
                    {
                        IntPtr row = new IntPtr(baseAddr + i * entrySize);
                        int type = (ushort)Marshal.ReadInt16(row, offType);
                        if (type != fileTypeIndex) continue;
                        int pid = (int)Marshal.ReadIntPtr(row, offPid).ToInt64();
                        if (pid == self || pid == 0 || pid == 4) continue;
                        uint access = (uint)Marshal.ReadInt32(row, offAccess);
                        if (Array.IndexOf(RiskyAccessMasks, access) >= 0) continue;
                        Entry e = new Entry();
                        e.Pid = pid;
                        e.Handle = Marshal.ReadIntPtr(row, offHandle);
                        e.Access = access;
                        result.Add(e);
                    }
                }
                finally
                {
                    if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                }
            }
        }
        finally
        {
            try { File.Delete(probePath); } catch { }
        }
        return result;
    }

    private static string Canonical(string path)
    {
        string full = Path.GetFullPath(path).TrimEnd('\\');
        IntPtr h = CreateFileW(full, 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (h == INVALID_HANDLE_VALUE || h == IntPtr.Zero) return full;
        try
        {
            StringBuilder sb = new StringBuilder(4096);
            uint len = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
            if (len > 0 && len < sb.Capacity) return StripPrefix(sb.ToString()).TrimEnd('\\');
            return full;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    private static string StripPrefix(string p)
    {
        if (p.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + p.Substring(8);
        if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p.Substring(4);
        return p;
    }

    private static bool IsInside(string path, string target)
    {
        if (string.Equals(path.TrimEnd('\\'), target, StringComparison.OrdinalIgnoreCase)) return true;
        return path.StartsWith(target + "\\", StringComparison.OrdinalIgnoreCase);
    }
}
