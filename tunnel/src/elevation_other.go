//go:build !windows

package main

import "fmt"

func ensureElevatedMode(mode string, _ bool, _ int, _ func()) (bool, error) {
	if mode == "wg" || mode == "rawsystem" {
		return false, fmt.Errorf("системные WG/RAW режимы этой сборкой поддерживаются только в Windows")
	}
	return false, nil
}
