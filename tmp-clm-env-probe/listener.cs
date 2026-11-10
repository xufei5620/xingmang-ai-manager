// 临时：数 WM_SETTINGCHANGE("Environment") 广播，核完就删。
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class Listener : NativeWindow {
  Listener() { CreateHandle(new CreateParams()); }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x001A) {
      string area = m.LParam == IntPtr.Zero ? "(null)" : Marshal.PtrToStringUni(m.LParam);
      Console.WriteLine("WM_SETTINGCHANGE " + area);
      Console.Out.Flush();
    }
    base.WndProc(ref m);
  }

  [STAThread]
  static void Main(string[] args) {
    Listener listener = new Listener();
    Timer timer = new Timer();
    timer.Interval = int.Parse(args[0]);
    timer.Tick += delegate { Application.ExitThread(); };
    timer.Start();
    Console.WriteLine("READY");
    Console.Out.Flush();
    Application.Run();
    GC.KeepAlive(listener);
  }
}
