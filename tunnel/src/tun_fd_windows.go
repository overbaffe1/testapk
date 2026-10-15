//go:build windows

package main

import (
	"fmt"
	"os"
)

// Передача TUN fd через SCM_RIGHTS существует только на Unix/Android.
// Windows desktop использует rawsocks и userspace netstack, поэтому сюда
// попадает лишь ошибочный ручной запуск -mode rawtun.
func recvTunFD(_ string) (*os.File, error) {
	return nil, fmt.Errorf("rawtun с внешним TUN fd не поддерживается в Windows; используйте -mode rawsocks")
}
