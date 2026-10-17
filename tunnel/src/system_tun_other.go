//go:build !windows

package main

import (
	"fmt"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

func prepareSystemRouting(_ []string) (func(), error) {
	return func() {}, fmt.Errorf("системные маршруты поддерживаются только в Windows")
}

func protectPhysicalEndpoint(_ string) error {
	return nil
}

func startSystemWireGuard(_ string) (*device.Device, func(), error) {
	return nil, func() {}, fmt.Errorf("системный WireGuard поддерживается только в Windows")
}

func startSystemRawTunnel(_, _ string, _ int) (tun.Device, func(), error) {
	return nil, func() {}, fmt.Errorf("системный RAW поддерживается только в Windows")
}
