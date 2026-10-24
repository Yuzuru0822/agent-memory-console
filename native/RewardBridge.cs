using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// A single bounded request, no script evaluation, keyboard input or coordinate clicks.
internal static class RewardBridge
{
    private const int MaxNodes = 3000, MaxDepth = 30, MaxElements = 500, MaxText = 300;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 40 };
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder text, ref int count);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder data, int length, out int needed);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);

    // WTSINFOEX_LEVEL1 starts at offset 8 because its LARGE_INTEGER fields require
    // 8-byte alignment. Only inspect the public lock/state header, never user data.
    [StructLayout(LayoutKind.Explicit)] private struct SessionHeader
    {
        [FieldOffset(0)] public int Level;
        [FieldOffset(8)] public int SessionId;
        [FieldOffset(12)] public int State;
        [FieldOffset(16)] public int Flags;
    }
    private sealed class Request
    {
        public string Action, Executable, Title;
        public Dictionary<string, object> Selector;
        public readonly List<string> ExpectedContext = new List<string>();
    }
    private sealed class WindowTarget
    {
        public IntPtr Handle;
        public uint ProcessId;
        public string Title, Executable;
        public int[] RootId;
    }
    private sealed class Pending
    {
        public AutomationElement Element;
        public int Depth;
        public Pending(AutomationElement element, int depth) { Element = element; Depth = depth; }
    }
    private sealed class ScanResult
    {
        public readonly List<object> Elements = new List<object>();
        public readonly List<AutomationElement> Matches = new List<AutomationElement>();
        public readonly HashSet<string> Context = new HashSet<string>(StringComparer.Ordinal);
    }

    [MTAThread]
    private static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        try
        {
            Request request = Parse(ReadRequest()); // Validate before accessing desktop APIs.
            CheckDesktop();
            WindowTarget window = FindWindow(request);
            CheckWindow(window);
            ScanResult scan = Scan(window, request.Selector);
            if (request.Action == "inspect")
            {
                CheckDesktop(); CheckWindow(window);
                Write(new { ok = true, title = window.Title, elements = scan.Elements });
            }
            else
            {
                if (scan.Matches.Count != 1) throw new InvalidOperationException(scan.Matches.Count == 0 ? "未找到精确匹配的控件，请重新读取界面" : "同一窗口存在多个匹配控件，拒绝执行");
                CheckDesktop(); CheckWindow(window);
                // Do not reuse the earlier screen observation for the final action.
                scan = Scan(window, request.Selector);
                if (scan.Matches.Count != 1) throw new InvalidOperationException("调用前控件匹配已变化，拒绝执行");
                foreach (string context in request.ExpectedContext)
                    if (!scan.Context.Contains(Normalize(context))) throw new InvalidOperationException("奖励活动上下文已变化，拒绝执行");
                CheckDesktop(); CheckWindow(window);
                AutomationElement element = scan.Matches[0];
                AutomationElement.AutomationElementInformation info = element.Current;
                if (info.IsPassword || info.ControlType == ControlType.Edit || !Matches(info, request.Selector) || !ActionType(info.ControlType) || !info.IsEnabled || info.IsOffscreen)
                    throw new InvalidOperationException("控件已变化、被禁用或不可见，拒绝执行");
                if (!String.Equals(ProcessImage((uint)info.ProcessId), request.Executable, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("控件所属程序已变化，拒绝执行");
                object pattern;
                if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new InvalidOperationException("控件不支持 InvokePattern，未执行其他点击方式");
                CheckDesktop(); CheckWindow(window);
                info = element.Current;
                if (info.IsPassword || !Matches(info, request.Selector) || !info.IsEnabled || info.IsOffscreen)
                    throw new InvalidOperationException("调用前控件状态已变化，拒绝执行");
                ((InvokePattern)pattern).Invoke();
                Write(new { ok = true });
            }
            return 0;
        }
        catch (Exception error)
        {
            string message = error is InvalidOperationException || error is ArgumentException || error is FileNotFoundException
                ? error.Message : "读取或调用 Windows 控件失败，请重新检查窗口状态";
            if (message.Length > 1000) message = message.Substring(0, 1000);
            Write(new { ok = false, error = message });
            return 1;
        }
    }
    private static void Write(object value) { Console.Out.WriteLine(Json.Serialize(value)); }
    private static string ReadRequest()
    {
        StringBuilder input = new StringBuilder();
        char[] block = new char[1024]; int count;
        while ((count = Console.In.Read(block, 0, block.Length)) > 0)
        {
            input.Append(block, 0, count);
            if (input.Length > 16384) throw new ArgumentException("请求超过大小限制");
        }
        return input.ToString();
    }
    private static Dictionary<string, object> Object(object value)
    {
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) throw new ArgumentException("请求必须是 JSON 对象");
        return result;
    }
    private static void Keys(Dictionary<string, object> data, params string[] allowed)
    {
        foreach (string key in data.Keys) if (Array.IndexOf(allowed, key) < 0) throw new ArgumentException("请求含未知字段");
    }
    private static string Text(Dictionary<string, object> data, string key, int max, bool required)
    {
        object value;
        if (!data.TryGetValue(key, out value)) { if (required) throw new ArgumentException("缺少请求字段：" + key); return null; }
        string text = value as string;
        if (text == null || text.Length > max || text.IndexOf('\0') >= 0 || (required && text.Length == 0)) throw new ArgumentException("请求字段无效：" + key);
        return text;
    }
    private static Request Parse(string text)
    {
        Dictionary<string, object> data;
        try { data = Object(Json.DeserializeObject(text)); } catch { throw new ArgumentException("请求不是有效的 JSON 对象"); }
        Keys(data, "action", "executable", "windowTitle", "selector", "expectedContext");
        string action = Text(data, "action", 20, true);
        if (action != "inspect" && action != "invoke") throw new ArgumentException("只支持 inspect 或 invoke 请求");
        string executable = LocalExecutable(Text(data, "executable", 2000, true));
        string title = Text(data, "windowTitle", 500, action == "invoke");
        Dictionary<string, object> selector = null;
        if (action == "invoke")
        {
            object raw; if (!data.TryGetValue("selector", out raw)) throw new ArgumentException("缺少 selector");
            selector = Object(raw); Keys(selector, "name", "automationId", "controlType");
            string name = Text(selector, "name", MaxText, false), id = Text(selector, "automationId", MaxText, false), type = Text(selector, "controlType", 50, true);
            if (name == null || id == null || (name.Length == 0 && id.Length == 0)) throw new ArgumentException("控件名称或标识不能为空");
            if (type != "Button" && type != "MenuItem" && type != "Hyperlink" && type != "TabItem") throw new ArgumentException("不支持此控件类型");
        }
        else if (data.ContainsKey("selector") || data.ContainsKey("expectedContext")) throw new ArgumentException("inspect 不接受 selector 或 expectedContext");
        Request request = new Request { Action = action, Executable = executable, Title = title, Selector = selector };
        object rawContext;
        if (data.TryGetValue("expectedContext", out rawContext))
        {
            object[] context = rawContext as object[];
            if (context == null || context.Length > 5) throw new ArgumentException("expectedContext 必须是不超过 5 项的字符串数组");
            foreach (object item in context)
            {
                string value = item as string;
                if (value == null || value.Length > MaxText || value.IndexOf('\0') >= 0 || Normalize(value).Length == 0) throw new ArgumentException("expectedContext 文本无效");
                request.ExpectedContext.Add(value);
            }
        }
        return request;
    }
    private static string LocalExecutable(string value)
    {
        if (value.Length < 4 || !Char.IsLetter(value[0]) || value[1] != ':' || (value[2] != '\\' && value[2] != '/') || value.Substring(2).Contains(":"))
            throw new ArgumentException("必须使用本地绝对 EXE 路径，不支持网络或设备路径");
        string result = Path.GetFullPath(value);
        if (!String.Equals(Path.GetExtension(result), ".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("只支持本地 EXE 程序");
        if (!File.Exists(result)) throw new FileNotFoundException("指定的 EXE 不存在");
        for (string current = result; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("EXE 路径包含链接或 junction");
        return result;
    }
    private static void CheckDesktop()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS only.
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("桌面已锁定或不可访问，请解锁后重试");
        try
        {
            StringBuilder name = new StringBuilder(256); int needed;
            if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) || !String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("当前不是可操作的 Default 桌面，请解锁后重试");
        }
        finally { CloseDesktop(desktop); }
        IntPtr buffer; int bytes; int session = Process.GetCurrentProcess().SessionId;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, 25, out buffer, out bytes)) throw new InvalidOperationException("无法确认桌面解锁状态，未执行控件操作");
        try
        {
            if (bytes < 20) throw new InvalidOperationException("无法确认桌面解锁状态");
            SessionHeader info = (SessionHeader)Marshal.PtrToStructure(buffer, typeof(SessionHeader));
            if (info.Level != 1 || info.SessionId != session || info.State != 0 || info.Flags != 1)
                throw new InvalidOperationException("桌面已锁定或会话未激活，请解锁后重试");
        }
        finally { WTSFreeMemory(buffer); }
    }
    private static string ProcessImage(uint processId)
    {
        IntPtr process = OpenProcess(0x1000, false, processId); // QUERY_LIMITED_INFORMATION.
        if (process == IntPtr.Zero) return null;
        try
        {
            StringBuilder name = new StringBuilder(32768); int length = name.Capacity;
            return QueryFullProcessImageName(process, 0, name, ref length) ? Path.GetFullPath(name.ToString()) : null;
        }
        finally { CloseHandle(process); }
    }
    private static string WindowTitle(IntPtr handle)
    {
        int length = GetWindowTextLength(handle);
        if (length > 500) throw new InvalidOperationException("窗口标题超过允许长度，无法安全识别");
        StringBuilder value = new StringBuilder(502); GetWindowText(handle, value, value.Capacity);
        if (value.Length > 500) throw new InvalidOperationException("窗口标题发生变化");
        return value.ToString();
    }
    private static WindowTarget FindWindow(Request request)
    {
        List<WindowTarget> matches = new List<WindowTarget>(); Exception failure = null;
        EnumWindowsCallback callback = delegate(IntPtr handle, IntPtr unused)
        {
            try
            {
                if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
                uint processId; GetWindowThreadProcessId(handle, out processId);
                if (!String.Equals(ProcessImage(processId), request.Executable, StringComparison.OrdinalIgnoreCase)) return true;
                string title = WindowTitle(handle);
                if (request.Title != null && !String.Equals(title, request.Title, StringComparison.Ordinal)) return true;
                matches.Add(new WindowTarget { Handle = handle, ProcessId = processId, Title = title, Executable = request.Executable });
                return true;
            }
            catch (Exception error) { failure = error; return false; }
        };
        bool complete = EnumWindows(callback, IntPtr.Zero); GC.KeepAlive(callback);
        if (failure != null) throw failure;
        if (!complete) throw new InvalidOperationException("无法完整读取目标窗口");
        if (matches.Count == 0) throw new InvalidOperationException("未找到指定程序的可见非最小化窗口，请先打开客户端");
        if (matches.Count != 1) throw new InvalidOperationException("目标程序存在多个匹配窗口，请指定唯一窗口标题");
        return matches[0];
    }
    private static void CheckWindow(WindowTarget window)
    {
        uint processId; GetWindowThreadProcessId(window.Handle, out processId);
        if (processId != window.ProcessId || !IsWindowVisible(window.Handle) || IsIconic(window.Handle) ||
            !String.Equals(ProcessImage(processId), window.Executable, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(WindowTitle(window.Handle), window.Title, StringComparison.Ordinal))
            throw new InvalidOperationException("目标窗口或程序身份已变化，请重新读取界面");
        if (window.RootId != null) Root(window);
    }
    private static AutomationElement Root(WindowTarget window)
    {
        AutomationElement root = AutomationElement.FromHandle(window.Handle);
        AutomationElement.AutomationElementInformation info = root.Current;
        if (info.ProcessId != window.ProcessId || new IntPtr(info.NativeWindowHandle) != window.Handle)
            throw new InvalidOperationException("窗口根控件身份与指定进程不一致");
        int[] identity = root.GetRuntimeId();
        if (identity == null || identity.Length == 0) throw new InvalidOperationException("无法确认窗口根控件身份");
        if (window.RootId != null)
        {
            if (identity.Length != window.RootId.Length) throw new InvalidOperationException("窗口根控件身份已变化");
            for (int i = 0; i < identity.Length; i++) if (identity[i] != window.RootId[i]) throw new InvalidOperationException("窗口根控件身份已变化");
        }
        else window.RootId = identity;
        return root;
    }
    private static string Normalize(string value) { return Regex.Replace(value, "[\\s\\uFEFF]+", " ").Trim().ToLowerInvariant(); }
    private static string TypeName(ControlType type) { return type.ProgrammaticName.Replace("ControlType.", ""); }
    private static bool ActionType(ControlType type) { return type == ControlType.Button || type == ControlType.MenuItem || type == ControlType.Hyperlink || type == ControlType.TabItem; }
    private static bool Matches(AutomationElement.AutomationElementInformation info, Dictionary<string, object> selector)
    {
        return String.Equals(info.Name, (string)selector["name"], StringComparison.Ordinal) &&
            String.Equals(info.AutomationId, (string)selector["automationId"], StringComparison.Ordinal) &&
            String.Equals(TypeName(info.ControlType), (string)selector["controlType"], StringComparison.Ordinal);
    }
    private static string Limit(string value) { value = value ?? ""; return value.Length <= MaxText ? value : value.Substring(0, MaxText); }
    // Pure projection kept separate so hidden success/context labels can be
    // regression-tested without loading or operating any client's UIA tree.
    private static object DisplayElement(int index, string name, string id, string type, bool enabled, bool actionable, bool offscreen)
    {
        if (offscreen) return null;
        return new { index = index, name = Limit(name), automationId = Limit(id), controlType = type, enabled = enabled, actionable = actionable };
    }
    private static ScanResult Scan(WindowTarget window, Dictionary<string, object> selector)
    {
        ScanResult result = new ScanResult(); Queue<Pending> queue = new Queue<Pending>();
        queue.Enqueue(new Pending(Root(window), 0));
        TreeWalker walker = TreeWalker.ControlViewWalker; int visited = 0;
        while (queue.Count > 0)
        {
            Pending pending = queue.Dequeue();
            if (++visited > MaxNodes) throw new InvalidOperationException("窗口控件超过 3000 个，拒绝不完整匹配");
            AutomationElement.AutomationElementInformation info = pending.Element.Current;
            if (info.IsPassword || info.ControlType == ControlType.Edit) continue; // Never read names, values or descendants of edits/password controls.
            string name = info.Name ?? "", id = info.AutomationId ?? "";
            if (info.ControlType == ControlType.Text && !info.IsOffscreen && name.Length <= MaxText) result.Context.Add(Normalize(name));
            if (selector != null && Matches(info, selector)) result.Matches.Add(pending.Element);
            object pattern;
            bool actionable = name.Length <= MaxText && id.Length <= MaxText && (name.Length > 0 || id.Length > 0) &&
                ActionType(info.ControlType) && info.IsEnabled && !info.IsOffscreen && pending.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern);
            // Hidden success labels must not become evidence for an already-claimed
            // result in the caller. Still traverse them and count duplicate selectors.
            if (result.Elements.Count < MaxElements)
            {
                object display = DisplayElement(result.Elements.Count, name, id, TypeName(info.ControlType), info.IsEnabled, actionable, info.IsOffscreen);
                if (display != null) result.Elements.Add(display);
            }
            for (AutomationElement child = walker.GetFirstChild(pending.Element); child != null; child = walker.GetNextSibling(child))
            {
                if (pending.Depth >= MaxDepth) throw new InvalidOperationException("窗口控件超过 30 层，拒绝不完整匹配");
                if (visited + queue.Count >= MaxNodes) throw new InvalidOperationException("窗口控件超过 3000 个，拒绝不完整匹配");
                queue.Enqueue(new Pending(child, pending.Depth + 1));
            }
        }
        return result;
    }
}
