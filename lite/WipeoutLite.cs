// Wipeout Lite: "Delete with Wipeout" in the folder right-click menu. No window.
//
//   wipeout-lite.exe                  double-click: add to (or remove from) the right-click menu
//   wipeout-lite.exe "D:\folder"      what the menu runs: stop what holds the folder, then delete it
//   wipeout-lite.exe --install [--quiet]
//   wipeout-lite.exe --uninstall [--quiet]
//   wipeout-lite.exe --scan "D:\folder"           print what holds the folder as JSON
//   wipeout-lite.exe "D:\folder" --yes --json      no dialogs, print the result as JSON (tests)
//
// Compiled together with ../scripts/WipeoutLocks.cs and ../scripts/LocksProgram.cs.
// C# 5 only, so the .NET Framework compiler that ships with Windows can build it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

public static class WipeoutLite
{
    public const string Version = "1.0.0";
    const string Title = "Wipeout";
    const string MenuKey = @"Software\Classes\Directory\shell\WipeoutLite";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\WipeoutLite";
    const string MenuText = "Delete with Wipeout";

    // Never stopped: Windows itself, security software and the shell.
    static readonly HashSet<string> NeverStop = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "System", "Idle", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "smss.exe",
        "svchost.exe", "dwm.exe", "explorer.exe", "MsMpEng.exe", "NisSrv.exe", "SearchIndexer.exe",
        "SearchProtocolHost.exe", "SearchFilterHost.exe", "fontdrvhost.exe", "sihost.exe", "ctfmon.exe",
    };

    // Editors, browsers and terminal windows: stopping one closes every window
    // and tab it has open, not just the part using this folder. Ask instead.
    static readonly HashSet<string> AskToClose = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Code.exe", "Code - Insiders.exe", "Cursor.exe", "Windsurf.exe", "devenv.exe", "idea64.exe",
        "webstorm64.exe", "pycharm64.exe", "rider64.exe", "clion64.exe", "goland64.exe", "studio64.exe",
        "WindowsTerminal.exe", "OpenConsole.exe", "conhost.exe", "mintty.exe",
        "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe",
        "WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE", "OUTLOOK.EXE", "Teams.exe", "ms-teams.exe",
    };

    static bool json;
    static bool yes;

    [STAThread]
    public static int Main(string[] args)
    {
        // Explorer may start us with the target folder as our working folder,
        // which would make us one of the things holding it.
        try { Directory.SetCurrentDirectory(Path.GetTempPath()); } catch { }

        string folder = null;
        bool scan = false, install = false, uninstall = false, quiet = false;
        foreach (string a in args)
        {
            if (a == "--json") json = true;
            else if (a == "--yes") yes = true;
            else if (a == "--quiet") quiet = true;
            else if (a == "--scan") scan = true;
            else if (a == "--install") install = true;
            else if (a == "--uninstall") uninstall = true;
            else if (a == "--version") { Out("{\"ok\":true,\"version\":\"" + Version + "\"}"); return 0; }
            else if (!a.StartsWith("--")) folder = a;
        }
        if (json) yes = true;

        try
        {
            if (install) return Install(quiet);
            if (uninstall) return Uninstall(quiet);
            if (folder == null) return DoubleClicked();
            if (scan) return ScanOnly(folder);
            return Wipe(folder);
        }
        catch (Exception ex)
        {
            Log("error " + ex);
            Fail("Something went wrong: " + ex.Message, null);
            return 1;
        }
    }

    // ---------- install ----------

    static string InstallDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Wipeout Lite"); }
    }

    static string LogDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Wipeout Lite"); }
    }

    static string InstalledExe { get { return Path.Combine(InstallDir, "wipeout-lite.exe"); } }

    static string SelfExe { get { return Process.GetCurrentProcess().MainModule.FileName; } }

    static bool IsInstalled()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(MenuKey + @"\command"))
        {
            return k != null && File.Exists(InstalledExe);
        }
    }

    static int DoubleClicked()
    {
        bool runningInstalled = string.Equals(Path.GetFullPath(SelfExe), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase);
        if (IsInstalled() && runningInstalled)
        {
            if (Ask("Wipeout Lite is installed.\n\nRemove \"" + MenuText + "\" from the right-click menu?", false)) return Uninstall(false);
            return 0;
        }
        if (IsInstalled())
        {
            // A newer download: update the installed copy without asking twice.
            return Install(false);
        }
        if (!Ask("Add \"" + MenuText + "\" to the right-click menu for folders?\n\n" +
                 "It stops whatever is holding a folder (a dev server, a terminal, a program running from it) " +
                 "and deletes the folder permanently. You can remove it any time from Settings > Apps.", true)) return 0;
        return Install(false);
    }

    static int Install(bool quiet)
    {
        Directory.CreateDirectory(InstallDir);
        string self = Path.GetFullPath(SelfExe);
        if (!string.Equals(self, Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(self, InstalledExe, true);
        }
        string exe = InstalledExe;

        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(MenuKey))
        {
            k.SetValue("", MenuText);
            k.SetValue("Icon", "\"" + exe + "\",0");
        }
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(MenuKey + @"\command"))
        {
            k.SetValue("", "\"" + exe + "\" \"%1\"");
        }
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", "Wipeout Lite");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "Shehryar Tariq");
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("InstallLocation", InstallDir);
            k.SetValue("URLInfoAbout", "https://getwipeout.vercel.app");
            k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
            k.SetValue("QuietUninstallString", "\"" + exe + "\" --uninstall --quiet");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)Math.Max(1, new FileInfo(exe).Length / 1024), RegistryValueKind.DWord);
        }
        ShellChanged();
        Log("installed " + Version + " to " + exe);
        if (json) Out("{\"ok\":true,\"installed\":" + Q(exe) + "}");
        else if (!quiet)
        {
            Info("Done. Right-click any folder and choose \"" + MenuText + "\".\n\n" +
                 "On Windows 11 it's under \"Show more options\", or hold Shift while you right-click to see it right away.");
        }
        return 0;
    }

    static int Uninstall(bool quiet)
    {
        Registry.CurrentUser.DeleteSubKeyTree(MenuKey, false);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        ShellChanged();
        Log("uninstalled");

        // A running .exe can't delete itself, so a hidden cmd removes the
        // installed copy a moment after we exit.
        bool removeFiles = Directory.Exists(InstallDir);
        if (json) Out("{\"ok\":true,\"uninstalled\":true}");
        else if (!quiet) Info("Removed. \"" + MenuText + "\" is gone from the right-click menu.");
        if (removeFiles)
        {
            var psi = new ProcessStartInfo("cmd.exe",
                "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + InstalledExe + "\" & rmdir /s /q \"" + InstallDir + "\"" +
                " & rmdir /s /q \"" + LogDir + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetTempPath();
            try { Process.Start(psi); } catch { }
        }
        return 0;
    }

    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    static void ShellChanged()
    {
        try { SHChangeNotify(0x08000000 /* SHCNE_ASSOCCHANGED */, 0, IntPtr.Zero, IntPtr.Zero); } catch { }
    }

    // ---------- what holds the folder ----------

    class Holder
    {
        public int Pid;
        public string Name;       // node.exe
        public string Label;      // "Node.js JavaScript Runtime: vite, localhost:5173"
        public string StartedAt;
        public string Reason;     // why it won't be stopped (null = will be stopped)
    }

    static List<Holder> FindHolders(string folder)
    {
        Dictionary<int, LocksProgram.ProcInfo> procs;
        Dictionary<int, bool> runsFrom;
        Dictionary<int, WipeoutLockInfo> found = LocksProgram.FindHolders(new string[] { folder }, 2, out procs, out runsFrom);
        Dictionary<int, List<int>> children = LocksProgram.ChildrenOf(procs);
        Dictionary<int, List<int>> ports = LocksProgram.ListeningPorts();
        int self = Process.GetCurrentProcess().Id;

        var list = new List<Holder>();
        foreach (WipeoutLockInfo h in found.Values)
        {
            LocksProgram.ProcInfo p;
            if (h.Pid == self || !procs.TryGetValue(h.Pid, out p)) continue;
            var holder = new Holder();
            holder.Pid = p.Pid;
            holder.Name = p.Name ?? ("process " + p.Pid);
            holder.StartedAt = p.StartedAt;
            holder.Label = Describe(p, LocksProgram.TreePorts(p.Pid, children, ports));
            if (p.Pid == 4 || NeverStop.Contains(holder.Name)) holder.Reason = WhyNot(holder.Name);
            else if (AskToClose.Contains(holder.Name)) holder.Reason = "close the folder there";
            list.Add(holder);
        }
        list.Sort(delegate (Holder a, Holder b) {
            int r = (a.Reason == null ? 0 : 1).CompareTo(b.Reason == null ? 0 : 1);
            return r != 0 ? r : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        });
        return list;
    }

    static string WhyNot(string name)
    {
        string n = (name ?? "").ToLowerInvariant();
        if (n == "explorer.exe") return "close File Explorer windows showing it";
        if (n == "msmpeng.exe" || n == "nissrv.exe") return "Windows Security is scanning it, wait a moment";
        if (n.StartsWith("search")) return "Windows Search is indexing it, wait a moment";
        return "part of Windows";
    }

    // "Node.js JavaScript Runtime (node.exe): vite, localhost:5173"
    static string Describe(LocksProgram.ProcInfo p, List<int> ports)
    {
        string friendly = null;
        try
        {
            if (!string.IsNullOrEmpty(p.Exe))
            {
                string d = FileVersionInfo.GetVersionInfo(p.Exe).FileDescription;
                if (!string.IsNullOrEmpty(d) && d.Trim().Length > 0) friendly = d.Trim();
            }
        }
        catch { }
        string name = p.Name ?? "process";
        string text = friendly != null && !friendly.Equals(name, StringComparison.OrdinalIgnoreCase)
            ? friendly + " (" + name + ")" : name;

        var details = new List<string>();
        string script = ScriptOf(p.CommandLine);
        if (script != null) details.Add(script);
        foreach (int port in ports) { if (details.Count >= 3) break; details.Add("localhost:" + port); }
        if (details.Count > 0) text += ": " + string.Join(", ", details.ToArray());
        return text;
    }

    // The package a Node process runs from node_modules (vite, next, webpack...), if any.
    static string ScriptOf(string commandLine)
    {
        if (string.IsNullOrEmpty(commandLine)) return null;
        string c = commandLine.Replace('/', '\\');
        int i = c.LastIndexOf(@"node_modules\", StringComparison.OrdinalIgnoreCase);
        if (i < 0) return null;
        string rest = c.Substring(i + 13);
        if (rest.StartsWith(".bin\\", StringComparison.OrdinalIgnoreCase)) rest = rest.Substring(5);
        if (rest.StartsWith("@"))
        {
            int slash = rest.IndexOf('\\');
            int second = slash < 0 ? -1 : rest.IndexOf('\\', slash + 1);
            return second < 0 ? null : rest.Substring(0, second).Replace('\\', '/');
        }
        int end = rest.IndexOfAny(new char[] { '\\', '"', ' ' });
        return end <= 0 ? null : rest.Substring(0, end);
    }

    static int ScanOnly(string folder)
    {
        string full = Path.GetFullPath(folder).TrimEnd('\\');
        var sb = new StringBuilder("{\"ok\":true,\"holders\":[");
        bool first = true;
        foreach (Holder h in FindHolders(full))
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"pid\":").Append(h.Pid).Append(",\"name\":").Append(Q(h.Name))
              .Append(",\"label\":").Append(Q(h.Label)).Append(",\"willStop\":").Append(h.Reason == null ? "true" : "false")
              .Append(",\"reason\":").Append(Q(h.Reason)).Append('}');
        }
        sb.Append("]}");
        Out(sb.ToString());
        return 0;
    }

    // ---------- wipe ----------

    static int Wipe(string folder)
    {
        string full;
        try { full = Path.GetFullPath(folder.Trim('"')).TrimEnd('\\'); }
        catch { Fail("That isn't a folder path: " + folder, null); return 1; }
        string name = Path.GetFileName(full);
        if (string.IsNullOrEmpty(name)) name = full;

        string refuse = ProtectedReason(full);
        if (refuse != null) { Fail("Wipeout won't delete \"" + full + "\".\n\n" + refuse, null); return 1; }

        var attrs = GetFileAttributesW(Long(full));
        if (attrs == INVALID_ATTRIBUTES) { Fail("\"" + name + "\" no longer exists.", null); return 1; }
        if ((attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) { Fail("\"" + name + "\" is a file, not a folder.", null); return 1; }

        var sw = Stopwatch.StartNew();

        // A link (junction or symbolic link) is removed on its own; whatever it
        // points to is never touched.
        if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            if (!yes && !Ask("\"" + name + "\" is a link to another folder.\n\nRemove the link? The folder it points to stays as it is.", true)) return 0;
            if (!RemoveDirectoryW(Long(full))) { Fail("Couldn't remove the link: " + ErrorText(Marshal.GetLastWin32Error()), null); return 1; }
            Done(full, new List<Holder>(), new List<Holder>(), 0, 1, new List<string>(), sw, true);
            return 0;
        }

        List<Holder> holders = FindHolders(full);
        var toStop = new List<Holder>();
        var toClose = new List<Holder>();
        foreach (Holder h in holders) (h.Reason == null ? toStop : toClose).Add(h);

        if (!yes && !Ask(ConfirmText(full, toStop, toClose), toStop.Count == 0)) return 0;

        var stopped = new List<Holder>();
        var stopFailed = new List<Holder>();
        foreach (Holder h in toStop) (Stop(h) ? stopped : stopFailed).Add(h);
        if (stopped.Count > 0) WaitForExit(stopped, 3000);

        long files = 0, dirs = 0;
        var errors = new List<string>();
        DeleteTree(full, ref files, ref dirs, errors);

        // Something may still have been holding on (a child that respawned,
        // a handle closing late). One more round after a short pause.
        if (Exists(full))
        {
            Thread.Sleep(400);
            List<Holder> again = FindHolders(full);
            foreach (Holder h in again)
            {
                if (h.Reason == null && !stopped.Exists(delegate (Holder s) { return s.Pid == h.Pid; }) && Stop(h)) stopped.Add(h);
            }
            errors.Clear();
            DeleteTree(full, ref files, ref dirs, errors);
            if (Exists(full))
            {
                List<Holder> still = FindHolders(full);
                Log("failed " + full + " errors=" + errors.Count + " holders=" + still.Count);
                Failed(full, stopped, still, stopFailed, errors, files);
                return 1;
            }
        }
        Done(full, stopped, toClose, files, dirs, errors, sw, false);
        return 0;
    }

    static string ConfirmText(string full, List<Holder> toStop, List<Holder> toClose)
    {
        var sb = new StringBuilder();
        sb.Append("Permanently delete this folder?\n\n").Append(full).Append("\n");
        if (toStop.Count > 0)
        {
            sb.Append("\nThese are using it and will be stopped first:\n");
            AppendList(sb, toStop, false);
        }
        if (toClose.Count > 0)
        {
            sb.Append("\nAlso open in (Wipeout won't stop these):\n");
            AppendList(sb, toClose, true);
        }
        sb.Append("\nThis can't be undone.");
        return sb.ToString();
    }

    static void AppendList(StringBuilder sb, List<Holder> list, bool withReason)
    {
        int shown = 0;
        foreach (Holder h in list)
        {
            if (shown == 6) { sb.Append("   and ").Append(list.Count - shown).Append(" more\n"); break; }
            sb.Append("   \u2022 ").Append(Cut(h.Label, 90));
            if (withReason && h.Reason != null) sb.Append(" (").Append(h.Reason).Append(')');
            sb.Append('\n');
            shown++;
        }
    }

    static bool Stop(Holder h)
    {
        // PIDs are reused: only stop it if it is still the same program.
        LocksProgram.ProcInfo now;
        if (!LocksProgram.SnapshotProcesses().TryGetValue(h.Pid, out now)) return true; // already gone
        if (!string.Equals(now.Name, h.Name, StringComparison.OrdinalIgnoreCase) || now.StartedAt != h.StartedAt)
        {
            Log("pid reused, left alone " + h.Pid + " " + h.Name);
            return false;
        }
        var psi = new ProcessStartInfo("taskkill.exe", "/F /T /PID " + h.Pid);
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        using (Process p = Process.Start(psi))
        {
            string output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit(10000);
            bool ok = p.ExitCode == 0 || output.IndexOf("not found", StringComparison.OrdinalIgnoreCase) >= 0;
            Log("taskkill " + h.Pid + " " + h.Name + (ok ? " ok" : " failed: " + output.Trim()));
            return ok;
        }
    }

    static void WaitForExit(List<Holder> list, int ms)
    {
        var sw = Stopwatch.StartNew();
        foreach (Holder h in list)
        {
            try
            {
                using (Process p = Process.GetProcessById(h.Pid))
                {
                    int left = ms - (int)sw.ElapsedMilliseconds;
                    if (left > 0) p.WaitForExit(left);
                }
            }
            catch { } // already gone
        }
    }

    static void Done(string full, List<Holder> stopped, List<Holder> leftOpen, long files, long dirs,
        List<string> errors, Stopwatch sw, bool linkOnly)
    {
        Log("deleted " + full + " files=" + files + " dirs=" + dirs + " stopped=" + stopped.Count + " ms=" + sw.ElapsedMilliseconds);
        if (json)
        {
            Out("{\"ok\":true,\"path\":" + Q(full) + ",\"linkOnly\":" + (linkOnly ? "true" : "false") +
                ",\"files\":" + files + ",\"folders\":" + dirs + ",\"stopped\":" + Pids(stopped) +
                ",\"ms\":" + sw.ElapsedMilliseconds + "}");
        }
        // No message when it worked: the folder disappearing is the answer.
    }

    static void Failed(string full, List<Holder> stopped, List<Holder> still, List<Holder> stopFailed,
        List<string> errors, long files)
    {
        bool denied = errors.Exists(delegate (string e) { return e.Contains("Access is denied"); }) || stopFailed.Count > 0;
        var sb = new StringBuilder();
        sb.Append("Couldn't delete everything in\n").Append(full).Append("\n");
        if (files > 0) sb.Append("\n").Append(files.ToString("N0")).Append(" files were deleted.\n");
        if (still.Count > 0)
        {
            sb.Append("\nStill in use by:\n");
            AppendList(sb, still, true);
        }
        if (errors.Count > 0)
        {
            sb.Append("\nFor example:\n");
            for (int i = 0; i < errors.Count && i < 3; i++) sb.Append("   ").Append(Cut(errors[i], 140)).Append('\n');
        }

        if (json)
        {
            Out("{\"ok\":false,\"path\":" + Q(full) + ",\"files\":" + files + ",\"stopped\":" + Pids(stopped) +
                ",\"stillHeldBy\":" + Pids(still) + ",\"errors\":" + errors.Count +
                ",\"firstError\":" + Q(errors.Count > 0 ? errors[0] : null) + "}");
            return;
        }
        if (denied && !LocksProgram.IsElevated())
        {
            sb.Append("\nSome of it needs administrator rights. Try again as administrator?");
            if (Ask(sb.ToString(), true)) RunAsAdmin(full);
            return;
        }
        Warn(sb.ToString());
    }

    static void RunAsAdmin(string full)
    {
        var psi = new ProcessStartInfo(SelfExe, "\"" + full + "\" --yes");
        psi.UseShellExecute = true;
        psi.Verb = "runas";
        try { Process.Start(psi); } catch { } // the user said no to the UAC prompt
    }

    static string Pids(List<Holder> list)
    {
        var parts = new List<string>();
        foreach (Holder h in list) parts.Add(h.Pid.ToString());
        return "[" + string.Join(",", parts.ToArray()) + "]";
    }

    // ---------- safety ----------

    static string ProtectedReason(string full)
    {
        string root = Path.GetPathRoot(full);
        if (string.IsNullOrEmpty(root) || string.Equals(full.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            return "That is a whole drive.";

        var critical = new List<string>();
        foreach (string v in new string[] { "SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData" })
        {
            string p = Environment.GetEnvironmentVariable(v);
            if (!string.IsNullOrEmpty(p)) critical.Add(p);
        }
        foreach (string c in critical)
            if (SameOrInside(full, c)) return "That is a Windows system or program folder.";

        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var keep = new List<string>();
        if (!string.IsNullOrEmpty(home))
        {
            keep.Add(home);
            keep.Add(Path.GetDirectoryName(home));
            foreach (string sub in new string[] { "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "OneDrive" })
                keep.Add(Path.Combine(home, sub));
        }
        foreach (Environment.SpecialFolder f in new Environment.SpecialFolder[] {
            Environment.SpecialFolder.ApplicationData, Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolder.Desktop, Environment.SpecialFolder.MyDocuments })
        {
            string p = Environment.GetFolderPath(f);
            if (!string.IsNullOrEmpty(p)) keep.Add(p);
        }
        string oneDrive = Environment.GetEnvironmentVariable("OneDrive");
        if (!string.IsNullOrEmpty(oneDrive)) keep.Add(oneDrive);
        foreach (string k in keep)
            if (!string.IsNullOrEmpty(k) && SameOrInside(k, full)) return "That folder holds your personal or system folders.";

        if (SameOrInside(SelfExe, full)) return "Wipeout itself is in that folder.";
        return null;
    }

    static bool SameOrInside(string path, string parent)
    {
        string a = path.TrimEnd('\\'), b = parent.TrimEnd('\\');
        return string.Equals(a, b, StringComparison.OrdinalIgnoreCase) ||
               a.StartsWith(b + "\\", StringComparison.OrdinalIgnoreCase);
    }

    // ---------- delete ----------

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WIN32_FIND_DATA
    {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
        public uint nFileSizeHigh, nFileSizeLow, dwReserved0, dwReserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string name, int infoLevel, out WIN32_FIND_DATA data, int searchOp, IntPtr filter, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr h, out WIN32_FIND_DATA data);
    [DllImport("kernel32.dll")]
    static extern bool FindClose(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool DeleteFileW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool RemoveDirectoryW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetFileAttributesW(string name, uint attrs);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributesW(string name);

    const uint FILE_ATTRIBUTE_READONLY = 0x1, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80, INVALID_ATTRIBUTES = 0xFFFFFFFF;
    const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_ACCESS_DENIED = 5, ERROR_DIR_NOT_EMPTY = 145;
    static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

    // \\?\ lifts the 260-character limit.
    static string Long(string path)
    {
        if (path.StartsWith(@"\\?\")) return path;
        if (path.StartsWith(@"\\")) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    static bool Exists(string full) { return GetFileAttributesW(Long(full)) != INVALID_ATTRIBUTES; }

    // Walks the folder (never following links), deletes every file in parallel,
    // then removes folders deepest first.
    static void DeleteTree(string full, ref long fileCount, ref long dirCount, List<string> errors)
    {
        var files = new List<string>();
        var links = new List<string>();     // linked folders: remove the link only
        var dirs = new List<KeyValuePair<int, string>>();
        var stack = new Stack<KeyValuePair<int, string>>();
        stack.Push(new KeyValuePair<int, string>(0, Long(full)));
        while (stack.Count > 0)
        {
            var cur = stack.Pop();
            dirs.Add(cur);
            WIN32_FIND_DATA d;
            IntPtr h = FindFirstFileExW(cur.Value + @"\*", 1 /* basic */, out d, 0, IntPtr.Zero, 2 /* large fetch */);
            if (h == INVALID_HANDLE) continue;
            try
            {
                do
                {
                    if (d.cFileName == "." || d.cFileName == "..") continue;
                    string p = cur.Value + "\\" + d.cFileName;
                    bool isDir = (d.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                    bool isLink = (d.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                    if (isDir && isLink) links.Add(p);
                    else if (isDir) stack.Push(new KeyValuePair<int, string>(cur.Key + 1, p));
                    else files.Add(p);
                } while (FindNextFileW(h, out d));
            }
            finally { FindClose(h); }
        }

        long removed = 0;
        var errLock = new object();
        Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = Math.Max(8, Environment.ProcessorCount * 4) }, delegate (string f) {
            string err = RemoveFile(f);
            if (err == null) Interlocked.Increment(ref removed);
            else lock (errLock) { if (errors.Count < 50) errors.Add(err); }
        });
        fileCount += removed;

        foreach (string l in links)
        {
            if (RemoveDirectoryW(l)) dirCount++;
            else errors.Add(Short(l) + ": " + ErrorText(Marshal.GetLastWin32Error()));
        }

        dirs.Sort(delegate (KeyValuePair<int, string> a, KeyValuePair<int, string> b) { return b.Key.CompareTo(a.Key); });
        foreach (var dir in dirs)
        {
            string err = RemoveDir(dir.Value);
            if (err == null) dirCount++;
            else if (errors.Count < 50) errors.Add(err);
        }
    }

    static string RemoveFile(string f)
    {
        if (DeleteFileW(f)) return null;
        int e = Marshal.GetLastWin32Error();
        if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) return null;
        if (e == ERROR_ACCESS_DENIED)
        {
            uint a = GetFileAttributesW(f);
            if (a != INVALID_ATTRIBUTES && (a & FILE_ATTRIBUTE_READONLY) != 0 && SetFileAttributesW(f, FILE_ATTRIBUTE_NORMAL) && DeleteFileW(f)) return null;
            e = Marshal.GetLastWin32Error();
        }
        return Short(f) + ": " + ErrorText(e);
    }

    static string RemoveDir(string d)
    {
        for (int attempt = 0; attempt < 6; attempt++)
        {
            if (RemoveDirectoryW(d)) return null;
            int e = Marshal.GetLastWin32Error();
            if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) return null;
            if (e == ERROR_ACCESS_DENIED)
            {
                uint a = GetFileAttributesW(d);
                if (a != INVALID_ATTRIBUTES && (a & FILE_ATTRIBUTE_READONLY) != 0) SetFileAttributesW(d, FILE_ATTRIBUTE_DIRECTORY);
            }
            // Deletes still finishing in the background leave the folder "not empty" for a moment.
            if (e != ERROR_DIR_NOT_EMPTY && e != ERROR_ACCESS_DENIED) return Short(d) + ": " + ErrorText(e);
            if (attempt == 5) return Short(d) + ": " + ErrorText(e);
            Thread.Sleep(30 * (attempt + 1));
        }
        return null;
    }

    static string Short(string p) { return p.StartsWith(@"\\?\UNC\") ? @"\\" + p.Substring(8) : p.StartsWith(@"\\?\") ? p.Substring(4) : p; }

    static string ErrorText(int code) { return new System.ComponentModel.Win32Exception(code).Message; }

    // ---------- dialogs and output ----------

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

    const uint MB_OK = 0, MB_YESNO = 4, MB_ICONERROR = 0x10, MB_ICONQUESTION = 0x20, MB_ICONWARNING = 0x30,
        MB_ICONINFORMATION = 0x40, MB_DEFBUTTON2 = 0x100, MB_SETFOREGROUND = 0x10000, MB_TOPMOST = 0x40000;

    static bool Ask(string text, bool defaultYes)
    {
        if (yes) return true;
        uint type = MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST | (defaultYes ? 0 : MB_DEFBUTTON2);
        return MessageBoxW(IntPtr.Zero, text, Title, type) == 6; // IDYES
    }

    static void Info(string text) { if (!json) MessageBoxW(IntPtr.Zero, text, Title, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND); }

    static void Warn(string text) { if (!json) MessageBoxW(IntPtr.Zero, text, Title, MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST); }

    static void Fail(string text, string path)
    {
        if (json) Out("{\"ok\":false,\"error\":" + Q(text) + "}");
        else MessageBoxW(IntPtr.Zero, text, Title, MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
    }

    static void Out(string text)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(text);
        try
        {
            using (Stream stdout = Console.OpenStandardOutput()) stdout.Write(bytes, 0, bytes.Length);
        }
        catch { } // started without a console (from Explorer)
    }

    static string Cut(string s, int max) { return s == null || s.Length <= max ? s : s.Substring(0, max - 1) + "\u2026"; }

    static string Q(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // One line per run in %LOCALAPPDATA%\Wipeout Lite\log.txt, kept under 256 KB.
    static void Log(string line)
    {
        try
        {
            string dir = LogDir;
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "log.txt");
            if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) File.Delete(file);
            File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine);
        }
        catch { }
    }
}
