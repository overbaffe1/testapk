//go:build windows

package main

import "net"

// На Windows повторное использование UDP-порта имеет другие правила;
// стандартный ListenPacket безопаснее, чем Unix SO_REUSEADDR через syscall.
func listenUDP(addr string) (net.PacketConn, error) {
	return net.ListenPacket("udp", addr)
}
