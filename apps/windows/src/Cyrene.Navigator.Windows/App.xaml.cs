// App.xaml.cs
//
// Application entry / 应用入口。

using System;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;

namespace Cyrene.Navigator.Windows;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diag.Log("AppDomain unhandled", e.ExceptionObject as Exception);

        UnhandledException += (_, e) =>
        {
            Diag.Log("XAML unhandled", e.Exception);
            e.Handled = false;
        };

        try
        {
            Diag.Log("app ctor: begin");
            InitializeComponent();
            Diag.Log("app ctor: resources loaded");

            // Light is the designed theme; dark exists but is not what this prototype is
            // judged on.
            Tk.Use(CyreneTheme.Light);
            Diag.Log("app ctor: tokens ready");
        }
        catch (Exception ex)
        {
            Diag.Log("App constructor", ex);
            throw;
        }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            _window = new MainWindow();
            _window.Activate();
            Diag.Log("window activated");
        }
        catch (Exception ex)
        {
            Diag.Log("OnLaunched", ex);
            throw;
        }
    }
}
