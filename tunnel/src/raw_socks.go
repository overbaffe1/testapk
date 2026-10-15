package main

import (
	"fmt"
	"net/netip"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// tunStreamAdapter приводит пакетный tun.Device к минимальному Read/Write/Close,
// который использует Dispatcher. Один вызов соответствует одному IP-пакету.
type tunStreamAdapter struct {
	dev tun.Device
}

func (a *tunStreamAdapter) Read(p []byte) (int, error) {
	bufs := [][]byte{p}
	sizes := []int{0}
	n, err := a.dev.Read(bufs, sizes, 0)
	if n > 0 {
		return sizes[0], err
	}
	return 0, err
}

func (a *tunStreamAdapter) Write(p []byte) (int, error) {
	n, err := a.dev.Write([][]byte{p}, 0)
	if err != nil {
		return 0, err
	}
	if n != 1 {
		return 0, fmt.Errorf("TUN: записано пакетов %d вместо 1", n)
	}
	return len(p), nil
}

func (a *tunStreamAdapter) Close() error {
	return a.dev.Close()
}

// startRawNetstack создаёт userspace TCP/IP-стек, чьи сырые IP-пакеты можно
// передать прямо в RAW-транспорт qWDTT, без WireGuard и системного TUN.
func startRawNetstack(ipText, dnsCSV string, mtu int) (*tunStreamAdapter, *netstack.Net, error) {
	ip, err := netip.ParseAddr(ipText)
	if err != nil || !ip.Is4() {
		return nil, nil, fmt.Errorf("RAW IP %q некорректен", ipText)
	}

	var dns []netip.Addr
	for _, part := range splitCommaList(dnsCSV) {
		addr, parseErr := netip.ParseAddr(part)
		if parseErr == nil && addr.Is4() {
			dns = append(dns, addr)
		}
	}
	if len(dns) == 0 {
		dns = []netip.Addr{netip.MustParseAddr("1.1.1.1")}
	}
	if mtu < 576 {
		mtu = 1280
	}

	dev, tnet, err := netstack.CreateNetTUN([]netip.Addr{ip}, dns, mtu)
	if err != nil {
		return nil, nil, fmt.Errorf("RAW netstack: %w", err)
	}
	return &tunStreamAdapter{dev: dev}, tnet, nil
}

func splitCommaList(value string) []string {
	var out []string
	start := 0
	for i, r := range value {
		if r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' {
			if i > start {
				out = append(out, value[start:i])
			}
			start = i + 1
		}
	}
	if start < len(value) {
		out = append(out, value[start:])
	}
	return out
}
