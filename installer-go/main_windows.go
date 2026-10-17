//go:build windows

package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	extensionID = "innpafjoibpjdgdemphggiomjlppglgj"
	hostName    = "com.wdtt.tunnel"
)

// Эти файлы кладёт workflow перед сборкой установщика.
//
//go:embed assets/wdtt-native-host.exe
var nativeHost []byte

//go:embed assets/wdtt-tunnel.exe
var tunnel []byte

//go:embed assets/wintun.dll
var wintunDLL []byte

var (
	user32         = windows.NewLazySystemDLL("user32.dll")
	messageBoxProc = user32.NewProc("MessageBoxW")
)

type nativeManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func main() {
	if err := install(); err != nil {
		messageBox("qWDTT — ошибка установки", err.Error(), 0x10)
		os.Exit(1)
	}
	messageBox(
		"qWDTT установлен",
		"Готово — компонент установлен для текущего пользователя.\n\n"+
			"Режим SOCKS5 работает без повышения прав.\n"+
			"Режимы WG и RAW создают системный Wintun и запросят UAC при подключении.\n"+
			"ID расширения: "+extensionID+"\n\n"+
			"Полностью закройте Chrome, откройте снова и нажмите «Подключить».",
		0x40,
	)
}

func install() error {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return fmt.Errorf("переменная LOCALAPPDATA не найдена")
	}

	home := filepath.Join(localAppData, "wdtt-tunnel")
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("создание каталога: %w", err)
	}

	// Останавливаем только процессы текущего пользователя с нашими именами.
	// Это позволяет бесшумно обновить уже установленную версию.
	killImage("wdtt-native-host.exe")
	killImage("wdtt-tunnel.exe")

	hostPath := filepath.Join(home, "wdtt-native-host.exe")
	tunnelPath := filepath.Join(binDir, "wdtt-tunnel.exe")
	wintunPath := filepath.Join(binDir, "wintun.dll")
	if err := replaceFile(hostPath, nativeHost); err != nil {
		return fmt.Errorf("установка native host: %w", err)
	}
	if err := replaceFile(tunnelPath, tunnel); err != nil {
		return fmt.Errorf("установка туннеля: %w", err)
	}
	if err := replaceFile(wintunPath, wintunDLL); err != nil {
		return fmt.Errorf("установка Wintun: %w", err)
	}

	manifestPath := filepath.Join(home, hostName+".json")
	manifest := nativeManifest{
		Name:           hostName,
		Description:    "qWDTT Chrome extension — WDTT tunnel control",
		Path:           hostPath,
		Type:           "stdio",
		AllowedOrigins: []string{"chrome-extension://" + extensionID + "/"},
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := replaceFile(manifestPath, append(body, '\n')); err != nil {
		return fmt.Errorf("запись manifest: %w", err)
	}

	registryPaths := []string{
		`Software\Google\Chrome\NativeMessagingHosts\` + hostName,
		`Software\Chromium\NativeMessagingHosts\` + hostName,
		`Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + hostName,
		`Software\Microsoft\Edge\NativeMessagingHosts\` + hostName,
	}
	for _, path := range registryPaths {
		key, _, createErr := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
		if createErr != nil {
			return fmt.Errorf("HKCU\\%s: %w", path, createErr)
		}
		setErr := key.SetStringValue("", manifestPath)
		_ = key.Close()
		if setErr != nil {
			return fmt.Errorf("HKCU\\%s: %w", path, setErr)
		}
	}
	return nil
}

func replaceFile(path string, content []byte) error {
	temporary := path + ".new"
	_ = os.Remove(temporary)
	if err := os.WriteFile(temporary, content, 0o755); err != nil {
		return err
	}
	_ = os.Remove(path)
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func killImage(name string) {
	cmd := exec.Command("taskkill.exe", "/F", "/IM", name)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}

func messageBox(title, text string, flags uintptr) {
	titlePtr, _ := windows.UTF16PtrFromString(title)
	textPtr, _ := windows.UTF16PtrFromString(text)
	_, _, _ = messageBoxProc.Call(
		0,
		uintptr(unsafe.Pointer(textPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		flags|0x00040000, // MB_TOPMOST
	)
}
