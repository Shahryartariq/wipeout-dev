// wipeout-locks.exe: finds every process holding one or more folders and
// prints a single JSON object to stdout. Compiled together with WipeoutLocks.cs.
//
//   wipeout-locks.exe --target "D:\proj" [--target ...] [--stdin] [--max-samples 4]
//   --stdin        read extra target folders from stdin, one per line
//   --self-test    print a JSON sample with tricky strings (used by the tests)
//
// C# 5 only, so the .NET Framework compiler that ships with Windows can build it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class LocksProgram
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returnLength);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int ProcessBasicInformation = 0;
    private const int ProcessCommandLineInformation = 60;
    private const int AF_INET = 2;
    private const int AF_INET6 = 23;
    private const int TCP_TABLE_OWNER_PID_LISTENER = 3;

    private class ProcInfo
    {
        public int Pid;
        public int ParentPid;
        public string Name;
        public string Exe;
        public string CommandLine;
        public string StartedAt;
    }

    public static int Main(string[] args)
    {
        var json = new JsonWriter();
        try
        {
            List<string> targets = new List<string>();
            int maxSamples = 4;
            bool readStdin = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--target" && i + 1 < args.Length) targets.Add(args[++i]);
                else if (args[i] == "--max-samples" && i + 1 < args.Length) maxSamples = int.Parse(args[++i]);
                else if (args[i] == "--stdin") readStdin = true;
                else if (args[i] == "--self-test") { WriteOut(SelfTest()); return 0; }
                else if (args[i] == "--describe" && i + 1 < args.Length) { WriteOut(Describe(int.Parse(args[i + 1]))); return 0; }
            }
            if (readStdin)
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Trim().Length > 0) targets.Add(line.Trim());
                    }
                }
            }
            if (targets.Count == 0) throw new ArgumentException("No folder given.");

            string[] full = new string[targets.Count];
            for (int t = 0; t < targets.Count; t++) full[t] = Path.GetFullPath(targets[t]).TrimEnd('\\');

            var sw = Stopwatch.StartNew();
            WipeoutLockInfo[] hits = WipeoutLocks.FindMany(full, maxSamples);

            Dictionary<int, ProcInfo> procs = SnapshotProcesses();
            Dictionary<int, List<int>> children = new Dictionary<int, List<int>>();
            foreach (ProcInfo p in procs.Values)
            {
                List<int> list;
                if (!children.TryGetValue(p.ParentPid, out list)) { list = new List<int>(); children[p.ParentPid] = list; }
                list.Add(p.Pid);
            }

            // Programs running from inside a folder lock it through their .exe.
            Dictionary<int, WipeoutLockInfo> found = new Dictionary<int, WipeoutLockInfo>();
            Dictionary<int, bool> runsFrom = new Dictionary<int, bool>();
            foreach (WipeoutLockInfo h in hits) found[h.Pid] = h;
            // Compare both the given and the real (long) form of each path, since
            // either side may use 8.3 short names like C:\\Users\\RUNNER~1.
            string[] canon = new string[full.Length];
            for (int t = 0; t < full.Length; t++) canon[t] = WipeoutLocks.Canonical(full[t]);
            foreach (ProcInfo p in procs.Values)
            {
                if (string.IsNullOrEmpty(p.Exe)) continue;
                string exeLong = p.Exe.IndexOf('~') >= 0 ? WipeoutLocks.Canonical(p.Exe) : p.Exe;
                for (int t = 0; t < full.Length; t++)
                {
                    if (!UnderAny(p.Exe, exeLong, full[t], canon[t])) continue;
                    WipeoutLockInfo info;
                    if (!found.TryGetValue(p.Pid, out info))
                    {
                        info = new WipeoutLockInfo();
                        info.Pid = p.Pid;
                        info.Samples = new string[] { p.Exe };
                        info.ModuleSamples = new string[0];
                        info.Targets = new int[0];
                        found[p.Pid] = info;
                    }
                    if (Array.IndexOf(info.Targets, t) < 0)
                    {
                        int[] grown = new int[info.Targets.Length + 1];
                        Array.Copy(info.Targets, grown, info.Targets.Length);
                        grown[info.Targets.Length] = t;
                        info.Targets = grown;
                    }
                    runsFrom[p.Pid] = true;
                    break;
                }
            }

            Dictionary<int, List<int>> ports = ListeningPorts();

            json.BeginObject();
            json.Prop("ok", true);
            json.Prop("error", (string)null);
            json.Prop("elevated", IsElevated());
            json.Prop("scanner", "helper");
            json.Prop("scanMs", (int)sw.ElapsedMilliseconds);
            json.Key("processes");
            json.BeginArray();
            foreach (WipeoutLockInfo h in found.Values)
            {
                ProcInfo p;
                if (!procs.TryGetValue(h.Pid, out p)) continue; // exited during the scan
                ProcInfo parent;
                procs.TryGetValue(p.ParentPid, out parent);

                json.BeginObject();
                json.Prop("pid", p.Pid);
                json.Prop("name", p.Name);
                json.Prop("exe", p.Exe);
                json.Prop("commandLine", p.CommandLine);
                json.Prop("parentPid", p.ParentPid);
                json.Prop("parentName", parent == null ? null : parent.Name);
                json.Prop("startedAt", p.StartedAt);
                json.Prop("handleCount", h.Count);
                json.Prop("holdsFolder", h.HoldsFolder);
                json.Prop("runsFromFolder", runsFrom.ContainsKey(p.Pid));
                json.Prop("moduleCount", h.ModuleCount);
                json.Key("samples"); json.Strings(h.Samples ?? new string[0]);
                json.Key("moduleSamples"); json.Strings(h.ModuleSamples ?? new string[0]);
                json.Key("targets"); json.Ints(h.Targets ?? new int[0]);
                json.Key("ports"); json.Ints(TreePorts(p.Pid, children, ports).ToArray());
                json.EndObject();
            }
            json.EndArray();
            json.EndObject();
            WriteOut(json.ToString());
            return 0;
        }
        catch (Exception ex)
        {
            var err = new JsonWriter();
            err.BeginObject();
            err.Prop("ok", false);
            err.Prop("error", ex.Message);
            err.Prop("scanner", "helper");
            err.Key("processes"); err.BeginArray(); err.EndArray();
            err.EndObject();
            WriteOut(err.ToString());
            return 1;
        }
    }

    private static void WriteOut(string text)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(text);
        using (Stream stdout = Console.OpenStandardOutput())
        {
            stdout.Write(bytes, 0, bytes.Length);
        }
    }

    private static bool IsElevated()
    {
        try
        {
            using (WindowsIdentity id = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch { return false; }
    }

    private static bool UnderAny(string exe, string exeLong, string target, string targetLong)
    {
        foreach (string e in new string[] { exe, exeLong })
            foreach (string t in new string[] { target, targetLong })
                if (e.StartsWith(t + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static Dictionary<int, ProcInfo> SnapshotProcesses()
    {
        var result = new Dictionary<int, ProcInfo>();
        Process[] all = Process.GetProcesses();
        foreach (Process proc in all)
        {
            var info = new ProcInfo();
            info.Pid = proc.Id;
            try { info.Name = proc.ProcessName; } catch { info.Name = null; }
            proc.Dispose();
            if (info.Pid == 0) continue;
            if (info.Pid == 4) { info.Name = "System"; result[4] = info; continue; }

            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, info.Pid);
            if (h != IntPtr.Zero)
            {
                try
                {
                    var sb = new StringBuilder(32768);
                    int size = sb.Capacity;
                    if (QueryFullProcessImageNameW(h, 0, sb, ref size)) info.Exe = sb.ToString();
                    info.ParentPid = ParentOf(h);
                    info.CommandLine = CommandLineOf(h);
                    long c, e, k, u;
                    if (GetProcessTimes(h, out c, out e, out k, out u) && c > 0)
                    {
                        info.StartedAt = DateTime.FromFileTimeUtc(c).ToString("o");
                    }
                }
                finally { CloseHandle(h); }
            }
            if (!string.IsNullOrEmpty(info.Exe)) info.Name = Path.GetFileName(info.Exe);
            else if (info.Name != null && !info.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) info.Name = info.Name + ".exe";
            result[info.Pid] = info;
        }
        return result;
    }

    private static int ParentOf(IntPtr process)
    {
        // PROCESS_BASIC_INFORMATION is six pointer-sized fields; the last is the parent's PID.
        int size = IntPtr.Size * 6;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            int ret;
            if (NtQueryInformationProcess(process, ProcessBasicInformation, buf, size, out ret) != 0) return 0;
            return (int)Marshal.ReadIntPtr(buf, IntPtr.Size * 5).ToInt64();
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    private static string CommandLineOf(IntPtr process)
    {
        int size = 4096;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                int needed;
                int status = NtQueryInformationProcess(process, ProcessCommandLineInformation, buf, size, out needed);
                if (status == 0)
                {
                    // UNICODE_STRING { ushort Length; ushort MaximumLength; [padding]; IntPtr Buffer }
                    int length = (ushort)Marshal.ReadInt16(buf);
                    IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
                    if (text == IntPtr.Zero || length == 0) return null;
                    return Marshal.PtrToStringUni(text, length / 2);
                }
                if (needed <= size) return null;
                size = needed + 16;
            }
            catch { return null; }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return null;
    }

    private static Dictionary<int, List<int>> ListeningPorts()
    {
        var ports = new Dictionary<int, List<int>>();
        try { ReadTcpTable(AF_INET, 24, 20, ports); } catch { }
        try { ReadTcpTable(AF_INET6, 56, 52, ports); } catch { }
        return ports;
    }

    // rowSize: bytes per row; pidOffset: offset of dwOwningPid in a row.
    // The local port sits at offset 8 (IPv4) or 20 (IPv6), in network byte order.
    private static void ReadTcpTable(int af, int rowSize, int pidOffset, Dictionary<int, List<int>> ports)
    {
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (size <= 0) return;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buf, ref size, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0) return;
            int count = Marshal.ReadInt32(buf);
            int portOffset = af == AF_INET ? 8 : 20;
            for (int i = 0; i < count; i++)
            {
                IntPtr row = new IntPtr(buf.ToInt64() + 4 + (long)i * rowSize);
                int raw = Marshal.ReadInt32(row, portOffset);
                int port = ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);
                int pid = Marshal.ReadInt32(row, pidOffset);
                List<int> list;
                if (!ports.TryGetValue(pid, out list)) { list = new List<int>(); ports[pid] = list; }
                if (!list.Contains(port)) list.Add(port);
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // Ports owned by a process or anything it started (npm -> node -> the actual server).
    private static List<int> TreePorts(int pid, Dictionary<int, List<int>> children, Dictionary<int, List<int>> ports)
    {
        var result = new List<int>();
        var seen = new HashSet<int>();
        var stack = new Stack<int>();
        stack.Push(pid);
        while (stack.Count > 0)
        {
            int cur = stack.Pop();
            if (!seen.Add(cur) || seen.Count > 512) continue;
            List<int> own;
            if (ports.TryGetValue(cur, out own)) foreach (int p in own) if (!result.Contains(p)) result.Add(p);
            List<int> kids;
            if (children.TryGetValue(cur, out kids)) foreach (int k in kids) if (k != cur) stack.Push(k);
        }
        result.Sort();
        return result;
    }

    // Name and start time of one process, so the app can make sure a PID still
    // belongs to the program it showed before stopping it.
    private static string Describe(int pid)
    {
        var j = new JsonWriter();
        j.BeginObject();
        ProcInfo p;
        SnapshotProcesses().TryGetValue(pid, out p);
        j.Prop("ok", true);
        j.Prop("exists", p != null);
        j.Prop("pid", pid);
        j.Prop("name", p == null ? null : p.Name);
        j.Prop("startedAt", p == null ? null : p.StartedAt);
        j.EndObject();
        return j.ToString();
    }

    private static string SelfTest()
    {
        var j = new JsonWriter();
        j.BeginObject();
        j.Prop("ok", true);
        j.Prop("quote", "say \"hi\"");
        j.Prop("path", @"C:\Users\Sherry\node_modules");
        j.Prop("control", "tab\tnewline\nbell\u0007");
        j.Prop("unicode", "caf\u00e9 \u0645\u0631\u062d\u0628\u0627 \ud83d\ude80");
        j.Prop("nothing", (string)null);
        j.Key("ints"); j.Ints(new int[] { 3000, 5173 });
        j.Key("strings"); j.Strings(new string[] { "a", null, "b" });
        j.EndObject();
        return j.ToString();
    }
}

// Minimal JSON writer: enough for this output, no dependencies.
public class JsonWriter
{
    private readonly StringBuilder sb = new StringBuilder();
    private readonly Stack<bool> hasItems = new Stack<bool>(); // one entry per open object/array
    private bool afterKey;

    private void ValueStart()
    {
        if (afterKey) { afterKey = false; return; }
        if (hasItems.Count == 0) return;
        if (hasItems.Peek()) sb.Append(',');
        hasItems.Pop();
        hasItems.Push(true);
    }

    public void BeginObject() { ValueStart(); sb.Append('{'); hasItems.Push(false); }
    public void EndObject() { sb.Append('}'); hasItems.Pop(); }
    public void BeginArray() { ValueStart(); sb.Append('['); hasItems.Push(false); }
    public void EndArray() { sb.Append(']'); hasItems.Pop(); }

    public void Key(string name)
    {
        if (hasItems.Peek()) sb.Append(',');
        hasItems.Pop();
        hasItems.Push(true);
        Str(name);
        sb.Append(':');
        afterKey = true;
    }

    public void Prop(string name, string value) { Key(name); ValueStart(); if (value == null) sb.Append("null"); else Str(value); }
    public void Prop(string name, int value) { Key(name); ValueStart(); sb.Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
    public void Prop(string name, bool value) { Key(name); ValueStart(); sb.Append(value ? "true" : "false"); }

    public void Ints(int[] values)
    {
        ValueStart();
        sb.Append('[');
        for (int i = 0; i < values.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(values[i].ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        sb.Append(']');
    }

    public void Strings(string[] values)
    {
        ValueStart();
        sb.Append('[');
        bool any = false;
        foreach (string v in values)
        {
            if (v == null) continue;
            if (any) sb.Append(',');
            Str(v);
            any = true;
        }
        sb.Append(']');
    }

    private void Str(string s)
    {
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    public override string ToString() { return sb.ToString(); }
}
