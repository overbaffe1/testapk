package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestElevatedModesGetDedicatedLogFile(t *testing.T) {
	for _, mode := range []string{"wg", "rawsystem"} {
		if !needsElevatedLog([]string{"-mode", mode}) {
			t.Fatalf("mode %s must use a shared log file", mode)
		}
	}
	for _, mode := range []string{"socks", "rawsocks"} {
		if needsElevatedLog([]string{"-mode=" + mode}) {
			t.Fatalf("mode %s must not request an elevated log file", mode)
		}
	}
	if !hasArg([]string{"-log-file=C:\\wdtt\\tunnel.log"}, "-log-file") {
		t.Fatal("equals-form argument was not detected")
	}
}

func TestStatusRemembersSocksReadinessBeyondLogTail(t *testing.T) {
	home := t.TempDir()
	host := &app{
		home:      home,
		statePath: filepath.Join(home, "state.json"),
		logPath:   filepath.Join(home, "tunnel.log"),
		out:       os.Stdout,
	}
	host.writeState(savedState{PID: os.Getpid()})
	if err := os.WriteFile(host.logPath, []byte("[SOCKS] listening 127.0.0.1:1080\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	first := host.status()
	if ready, _ := first["socksReady"].(bool); !ready {
		t.Fatal("SOCKS marker was not detected")
	}

	file, err := os.OpenFile(host.logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 250; i++ {
		_, _ = fmt.Fprintf(file, "[СТАТ] строка %d\n", i)
	}
	_ = file.Close()

	second := host.status()
	if ready, _ := second["socksReady"].(bool); !ready {
		t.Fatal("SOCKS readiness was lost after marker left the 200-line log tail")
	}
	if !host.readState().SocksReady {
		t.Fatal("SOCKS readiness was not persisted")
	}
}
