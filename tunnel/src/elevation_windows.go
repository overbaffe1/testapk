//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

func systemMode(mode string) bool {
	return mode == "wg" || mode == "rawsystem"
}

func isProcessElevated() bool {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return false
	}
	defer token.Close()
	return token.IsElevated()
}

func powershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func encodePowerShell(script string) string {
	encoded := utf16.Encode([]rune(script))
	bytes := make([]byte, len(encoded)*2)
	for i, value := range encoded {
		bytes[i*2] = byte(value)
		bytes[i*2+1] = byte(value >> 8)
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

func monitorParentProcess(pid int, onExit func()) {
	if pid <= 0 {
		return
	}
	go func() {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
		if err != nil {
			return
		}
		defer windows.CloseHandle(handle)
		_, _ = windows.WaitForSingleObject(handle, windows.INFINITE)
		if onExit != nil {
			onExit()
		}
	}()
}

func runElevatedAndWait(parentPID int) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := append([]string{}, os.Args[1:]...)
	args = append(args, "-elevated-child=true", "-parent-pid="+strconv.Itoa(parentPID))
	quotedArgs := make([]string, 0, len(args))
	for _, arg := range args {
		quotedArgs = append(quotedArgs, syscall.EscapeArg(arg))
	}
	argumentLine := strings.Join(quotedArgs, " ")
	script := "$p = Start-Process -FilePath " + powershellQuote(exe) +
		" -WorkingDirectory " + powershellQuote(filepath.Dir(exe)) +
		" -ArgumentList " + powershellQuote(argumentLine) +
		" -Verb RunAs -WindowStyle Hidden -PassThru; " +
		"$p.WaitForExit(); exit $p.ExitCode"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, runErr := cmd.CombinedOutput(); runErr != nil {
		return fmt.Errorf("UAC/Start-Process: %w (%s)", runErr, strings.TrimSpace(string(output)))
	}
	return nil
}

// ensureElevatedMode превращает исходный процесс в broker: он запрашивает UAC,
// ждёт elevated child и остаётся PID, который отслеживает native host.
func ensureElevatedMode(mode string, elevatedChild bool, parentPID int, onParentExit func()) (bool, error) {
	if !systemMode(mode) {
		return false, nil
	}
	if elevatedChild {
		if !isProcessElevated() {
			return false, fmt.Errorf("дочерний процесс запущен без elevation")
		}
		monitorParentProcess(parentPID, onParentExit)
		return false, nil
	}
	if isProcessElevated() {
		return false, nil
	}
	return true, runElevatedAndWait(os.Getpid())
}
