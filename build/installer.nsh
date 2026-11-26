; electron-builder 的默认检查按路径前缀匹配进程（$_.Path.StartsWith($INSTDIR)），
; $INSTDIR 为空时会命中所有进程并逐个 Stop-Process，曾结束 explorer.exe 及无关后台程序。
; 本应用安装时不需要该检查，置空以移除误杀风险。
!macro customCheckAppRunning
!macroend