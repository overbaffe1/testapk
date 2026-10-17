//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func configureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false
	}
	text := strings.ToLower(string(out))
	return strings.Contains(text, `"`+strconv.Itoa(pid)+`"`) && !strings.Contains(text, "no tasks")
}

func terminatePID(pid int) error {
	if pid <= 0 {
		return nil
	}
	// Не используем /T: в системных режимах этот PID является unelevated
	// broker, а elevated tunnel сам завершится, увидев закрытие broker.
	return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F").Run()
}
