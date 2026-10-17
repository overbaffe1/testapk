//go:build windows

package main

import (
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

const systemInterfaceName = "qWDTT"

var physicalRoutes = struct {
	sync.Mutex
	ready          bool
	interfaceIndex int
	gateway        string
	protected      map[string]bool
	owned          map[string]bool
}{}

func runHidden(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.CombinedOutput()
}

func runPowerShell(script string) error {
	out, err := runHidden("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script))
	if err != nil {
		return fmt.Errorf("PowerShell: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func capturePhysicalDefaultRoute() (int, string, error) {
	script := `$r = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ` +
		`Where-Object { $_.InterfaceAlias -ne 'qWDTT' -and $_.NextHop -ne '0.0.0.0' } | ` +
		`Sort-Object RouteMetric | Select-Object -First 1; ` +
		`if ($null -eq $r) { exit 3 }; Write-Output ($r.InterfaceIndex.ToString() + '|' + $r.NextHop)`
	out, err := runHidden("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script))
	if err != nil {
		return 0, "", fmt.Errorf("не найден физический default route: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 2 {
		return 0, "", fmt.Errorf("неожиданный default route: %q", strings.TrimSpace(string(out)))
	}
	index, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || index <= 0 || net.ParseIP(strings.TrimSpace(parts[1])).To4() == nil {
		return 0, "", fmt.Errorf("некорректный default route: %q", strings.TrimSpace(string(out)))
	}
	return index, strings.TrimSpace(parts[1]), nil
}

func directPatternHost(pattern string) string {
	value := strings.TrimSpace(strings.ToLower(pattern))
	if value == "" || value == "<local>" {
		return ""
	}
	if strings.Contains(value, "://") {
		if parsed, err := url.Parse(value); err == nil {
			value = parsed.Hostname()
		}
	} else {
		value = strings.SplitN(value, "/", 2)[0]
		if host, _, err := net.SplitHostPort(value); err == nil {
			value = host
		}
	}
	value = strings.TrimPrefix(value, "*.")
	if strings.ContainsAny(value, "*?") {
		return ""
	}
	return strings.Trim(value, "[]")
}

func addPhysicalRoute(ip string) error {
	physicalRoutes.Lock()
	if !physicalRoutes.ready {
		physicalRoutes.Unlock()
		return nil
	}
	if physicalRoutes.protected[ip] {
		physicalRoutes.Unlock()
		return nil
	}
	index := physicalRoutes.interfaceIndex
	gateway := physicalRoutes.gateway
	physicalRoutes.protected[ip] = true
	physicalRoutes.Unlock()

	out, err := runHidden("route.exe", "ADD", ip, "MASK", "255.255.255.255", gateway, "METRIC", "1", "IF", strconv.Itoa(index))
	if err == nil {
		physicalRoutes.Lock()
		physicalRoutes.owned[ip] = true
		physicalRoutes.Unlock()
		log.Printf("[СИСТЕМА] Физический маршрут: %s через %s (if %d)", ip, gateway, index)
		return nil
	}
	// Route already exists — это нормально; проверить наличие проще и надёжнее,
	// чем разбирать локализованный вывод route.exe.
	check, _ := runHidden("route.exe", "PRINT", ip)
	if strings.Contains(string(check), ip) {
		return nil
	}
	return fmt.Errorf("route ADD: %w (%s)", err, strings.TrimSpace(string(out)))
}

func protectHost(host string) error {
	if host == "" {
		return nil
	}
	if parsed := net.ParseIP(host); parsed != nil {
		if v4 := parsed.To4(); v4 != nil {
			return addPhysicalRoute(v4.String())
		}
		return nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return err
	}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			if err := addPhysicalRoute(v4.String()); err != nil {
				return err
			}
		}
	}
	return nil
}

func prepareSystemRouting(bypassPatterns []string) (func(), error) {
	index, gateway, err := capturePhysicalDefaultRoute()
	if err != nil {
		return func() {}, err
	}
	physicalRoutes.Lock()
	physicalRoutes.ready = true
	physicalRoutes.interfaceIndex = index
	physicalRoutes.gateway = gateway
	physicalRoutes.protected = make(map[string]bool)
	physicalRoutes.owned = make(map[string]bool)
	physicalRoutes.Unlock()

	for _, pattern := range bypassPatterns {
		host := directPatternHost(pattern)
		if host == "" {
			continue
		}
		if err := protectHost(host); err != nil {
			log.Printf("[СПЛИТ] Не удалось подготовить %s: %v", host, err)
		}
	}

	cleanup := func() {
		physicalRoutes.Lock()
		owned := make([]string, 0, len(physicalRoutes.owned))
		for ip := range physicalRoutes.owned {
			owned = append(owned, ip)
		}
		physicalRoutes.ready = false
		physicalRoutes.Unlock()
		for _, ip := range owned {
			_, _ = runHidden("route.exe", "DELETE", ip)
		}
	}
	return cleanup, nil
}

func protectPhysicalEndpoint(endpoint string) error {
	host := endpoint
	if splitHost, _, err := net.SplitHostPort(endpoint); err == nil {
		host = strings.Trim(splitHost, "[]")
	}
	return protectHost(host)
}

func firstIPv4Prefix(prefixes []netip.Prefix, addresses []netip.Addr) (netip.Prefix, error) {
	for _, prefix := range prefixes {
		if prefix.Addr().Is4() {
			return prefix, nil
		}
	}
	for _, address := range addresses {
		if address.Is4() {
			return netip.PrefixFrom(address, 32), nil
		}
	}
	return netip.Prefix{}, fmt.Errorf("IPv4 Address отсутствует")
}

func ipv4DNS(dns []netip.Addr) []string {
	var result []string
	for _, address := range dns {
		if address.Is4() {
			result = append(result, address.String())
		}
	}
	if len(result) == 0 {
		result = []string{"1.1.1.1", "8.8.8.8"}
	}
	return result
}

func configureSystemInterface(prefix netip.Prefix, dns []string, mtu int) error {
	if mtu < 576 {
		mtu = 1280
	}
	dnsValues := make([]string, 0, len(dns))
	for _, value := range dns {
		if net.ParseIP(value).To4() != nil {
			dnsValues = append(dnsValues, powershellQuote(value))
		}
	}
	if len(dnsValues) == 0 {
		dnsValues = []string{"'1.1.1.1'", "'8.8.8.8'"}
	}
	script := `$ErrorActionPreference = 'Stop'; ` +
		`$a = $null; for ($i=0; $i -lt 40 -and $null -eq $a; $i++) { ` +
		`$a = Get-NetAdapter -Name 'qWDTT' -ErrorAction SilentlyContinue; if ($null -eq $a) { Start-Sleep -Milliseconds 250 } }; ` +
		`if ($null -eq $a) { throw 'qWDTT adapter not found' }; ` +
		`Get-NetRoute -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ` +
		`Where-Object { $_.DestinationPrefix -eq '0.0.0.0/1' -or $_.DestinationPrefix -eq '128.0.0.0/1' } | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue; ` +
		`Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue; ` +
		`New-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress ` + powershellQuote(prefix.Addr().String()) +
		` -PrefixLength ` + strconv.Itoa(prefix.Bits()) + ` -PolicyStore ActiveStore | Out-Null; ` +
		`Set-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -InterfaceMetric 3 -NlMtuBytes ` + strconv.Itoa(mtu) + `; ` +
		`Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses @(` + strings.Join(dnsValues, ",") + `); ` +
		`New-NetRoute -DestinationPrefix '0.0.0.0/1' -InterfaceIndex $a.ifIndex -NextHop '0.0.0.0' -RouteMetric 1 -PolicyStore ActiveStore | Out-Null; ` +
		`New-NetRoute -DestinationPrefix '128.0.0.0/1' -InterfaceIndex $a.ifIndex -NextHop '0.0.0.0' -RouteMetric 1 -PolicyStore ActiveStore | Out-Null`
	return runPowerShell(script)
}

func cleanupSystemInterface() {
	script := `$a = Get-NetAdapter -Name 'qWDTT' -ErrorAction SilentlyContinue; if ($null -ne $a) { ` +
		`Get-NetRoute -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ` +
		`Where-Object { $_.DestinationPrefix -eq '0.0.0.0/1' -or $_.DestinationPrefix -eq '128.0.0.0/1' } | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue; ` +
		`Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue; ` +
		`Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }`
	_ = runPowerShell(script)
}

func createSystemTUN(prefix netip.Prefix, dns []string, mtu int) (tun.Device, func(), error) {
	tun.WintunTunnelType = "qWDTT"
	dev, err := tun.CreateTUN(systemInterfaceName, mtu)
	if err != nil {
		return nil, func() {}, fmt.Errorf("Wintun CreateTUN: %w (проверьте wintun.dll и UAC)", err)
	}
	if err := configureSystemInterface(prefix, dns, mtu); err != nil {
		_ = dev.Close()
		return nil, func() {}, err
	}
	return dev, cleanupSystemInterface, nil
}

func startSystemWireGuard(confText string) (*device.Device, func(), error) {
	cfg, err := parseWgQuick(confText)
	if err != nil {
		return nil, func() {}, err
	}
	prefix, err := firstIPv4Prefix(cfg.prefixes, cfg.addresses)
	if err != nil {
		return nil, func() {}, err
	}
	tunDev, cleanup, err := createSystemTUN(prefix, ipv4DNS(cfg.dns), cfg.mtu)
	if err != nil {
		return nil, func() {}, err
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "[WG-SYSTEM] "))
	if err := dev.IpcSet(cfg.ipcRequest()); err != nil {
		dev.Close()
		cleanup()
		return nil, func() {}, fmt.Errorf("IpcSet: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		cleanup()
		return nil, func() {}, fmt.Errorf("Up: %w", err)
	}
	// Дать интерфейсу применить IP/маршруты до открытия локального SOCKS.
	time.Sleep(300 * time.Millisecond)
	return dev, cleanup, nil
}

func startSystemRawTunnel(ipText, dnsCSV string, mtu int) (tun.Device, func(), error) {
	ip, err := netip.ParseAddr(ipText)
	if err != nil || !ip.Is4() {
		return nil, func() {}, fmt.Errorf("RAW IP %q некорректен", ipText)
	}
	var dns []string
	for _, value := range splitCommaList(dnsCSV) {
		if parsed := net.ParseIP(value); parsed != nil && parsed.To4() != nil {
			dns = append(dns, parsed.String())
		}
	}
	return createSystemTUN(netip.PrefixFrom(ip, 32), dns, mtu)
}
