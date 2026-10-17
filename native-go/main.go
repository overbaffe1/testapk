package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const hostName = "com.wdtt.tunnel"

type request struct {
	ID      any             `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type response struct {
	ID      any    `json:"id,omitempty"`
	Type    string `json:"type"`
	OK      bool   `json:"ok"`
	Payload any    `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
	Event   string `json:"event,omitempty"`
}

type startPayload struct {
	Args   []string `json:"args"`
	Binary string   `json:"binary"`
	Socks  any      `json:"socks"`
}

type checkPayload struct {
	Socks struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		User string `json:"user"`
		Pass string `json:"pass"`
	} `json:"socks"`
}

type savedState struct {
	PID        int      `json:"pid"`
	StartedAt  int64    `json:"startedAt"`
	Binary     string   `json:"binary"`
	Args       []string `json:"args"`
	Socks      any      `json:"socks,omitempty"`
	SocksReady bool     `json:"socksReady"`
	Error      string   `json:"error,omitempty"`
}

type app struct {
	home      string
	statePath string
	logPath   string
	out       io.Writer
	writeMu   sync.Mutex
	stateMu   sync.Mutex
	cmd       *exec.Cmd
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	home := os.Getenv("WDTT_HOME")
	if home == "" {
		home = filepath.Dir(exe)
	}
	if err := os.MkdirAll(filepath.Join(home, "bin"), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	host := &app{
		home:      home,
		statePath: filepath.Join(home, "state.json"),
		logPath:   filepath.Join(home, "tunnel.log"),
		out:       os.Stdout,
	}
	if err := host.loop(os.Stdin); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, "qWDTT native host:", err)
	}
}

func (a *app) loop(input io.Reader) error {
	for {
		var size uint32
		if err := binary.Read(input, binary.LittleEndian, &size); err != nil {
			return err
		}
		if size == 0 || size > 4*1024*1024 {
			return fmt.Errorf("некорректная длина сообщения: %d", size)
		}
		body := make([]byte, size)
		if _, err := io.ReadFull(input, body); err != nil {
			return err
		}
		var req request
		if err := json.Unmarshal(body, &req); err != nil {
			continue
		}
		a.handle(req)
	}
}

func (a *app) write(value response) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	_ = binary.Write(a.out, binary.LittleEndian, uint32(len(data)))
	_, _ = a.out.Write(data)
}

func (a *app) ok(id any, payload any) {
	a.write(response{ID: id, Type: "result", OK: true, Payload: payload})
}

func (a *app) fail(id any, err error, code string) {
	a.write(response{ID: id, Type: "result", OK: false, Error: err.Error(), Code: code})
}

func (a *app) emitStatus(status map[string]any) {
	a.write(response{Type: "event", OK: true, Event: "status", Payload: status})
}

func decodePayload(raw json.RawMessage, out any) error {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (a *app) handle(req request) {
	switch req.Type {
	case "ping":
		a.ok(req.ID, map[string]any{"pong": true, "host": hostName, "pid": os.Getpid(), "home": a.home})
	case "status":
		a.ok(req.ID, map[string]any{"status": a.status()})
	case "start":
		var payload startPayload
		if err := decodePayload(req.Payload, &payload); err != nil {
			a.fail(req.ID, err, "bad-payload")
			return
		}
		result, err := a.start(payload)
		if err != nil {
			a.fail(req.ID, err, "start-failed")
			return
		}
		a.ok(req.ID, result)
		a.emitStatus(result["status"].(map[string]any))
	case "stop":
		result := a.stop()
		a.ok(req.ID, result)
		a.emitStatus(result["status"].(map[string]any))
	case "logs":
		lines := 120
		var payload struct {
			Lines int `json:"lines"`
		}
		_ = decodePayload(req.Payload, &payload)
		if payload.Lines > 0 {
			lines = payload.Lines
		}
		a.ok(req.ID, map[string]any{"lines": tailFile(a.logPath, lines)})
	case "check":
		var payload checkPayload
		if err := decodePayload(req.Payload, &payload); err != nil {
			a.fail(req.ID, err, "bad-payload")
			return
		}
		result, err := checkIP(payload)
		if err != nil {
			a.fail(req.ID, err, "check-failed")
			return
		}
		a.ok(req.ID, result)
	default:
		a.fail(req.ID, fmt.Errorf("неизвестная команда: %s", req.Type), "unknown")
	}
}

func (a *app) readState() savedState {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	var state savedState
	data, err := os.ReadFile(a.statePath)
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}

func (a *app) writeState(state savedState) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	data, _ := json.MarshalIndent(state, "", "  ")
	_ = os.WriteFile(a.statePath, data, 0o600)
}

func (a *app) findBinary(explicit string) string {
	name := "wdtt-tunnel"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	candidates := []string{
		explicit,
		os.Getenv("WDTT_TUNNEL_BIN"),
		filepath.Join(a.home, "bin", name),
		filepath.Join(a.home, name),
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			absolute, _ := filepath.Abs(candidate)
			return absolute
		}
	}
	if found, err := exec.LookPath(name); err == nil {
		return found
	}
	return ""
}

func (a *app) status() map[string]any {
	state := a.readState()
	running := processAlive(state.PID)
	lines := tailFile(a.logPath, 200)

	// Раньше готовность каждый раз искалась только в последних 200 строках.
	// Когда активный туннель писал достаточно лога, строка "[SOCKS] listening"
	// выпадала из хвоста и UI ошибочно возвращался в «Подключение…».
	ready := running && state.SocksReady
	if running && !ready {
		for _, line := range lines {
			if strings.Contains(line, "[SOCKS] listening") {
				ready = true
				state.SocksReady = true
				a.writeState(state)
				break
			}
		}
	}
	if !running && state.SocksReady {
		state.SocksReady = false
		a.writeState(state)
	}

	binaryPath := state.Binary
	if binaryPath == "" {
		binaryPath = a.findBinary("")
	}
	return map[string]any{
		"running":     running,
		"socksReady":  ready,
		"pid":         chooseInt(running, state.PID, 0),
		"startedAt":   state.StartedAt,
		"socks":       state.Socks,
		"args":        state.Args,
		"binaryPath":  binaryPath,
		"binaryFound": binaryPath != "",
		"error":       state.Error,
		"logTail":     tailSlice(lines, 40),
	}
}

func (a *app) start(payload startPayload) (map[string]any, error) {
	current := a.status()
	if current["running"].(bool) {
		return map[string]any{"started": false, "status": current}, nil
	}
	binaryPath := a.findBinary(payload.Binary)
	if binaryPath == "" {
		state := a.readState()
		state.PID = 0
		state.SocksReady = false
		state.Error = "Компонент туннеля wdtt-tunnel не установлен"
		a.writeState(state)
		return nil, errors.New(state.Error)
	}
	if info, err := os.Stat(a.logPath); err == nil && info.Size() > 8*1024*1024 {
		_ = os.Rename(a.logPath, a.logPath+".1")
	}
	logFile, err := os.OpenFile(a.logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	args := append([]string{}, payload.Args...)
	if needsElevatedLog(args) && !hasArg(args, "-log-file") {
		args = append(args, "-log-file", a.logPath)
	}
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = a.home
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	configureDetached(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, fmt.Errorf("не удалось запустить туннель: %w", err)
	}
	_ = logFile.Close()
	a.cmd = cmd
	state := savedState{
		PID:        cmd.Process.Pid,
		StartedAt:  time.Now().UnixMilli(),
		Binary:     binaryPath,
		Args:       args,
		Socks:      payload.Socks,
		SocksReady: false,
	}
	a.writeState(state)
	go func() {
		err := cmd.Wait()
		latest := a.readState()
		if latest.PID != cmd.Process.Pid {
			return
		}
		latest.PID = 0
		latest.SocksReady = false
		if err != nil {
			latest.Error = "Туннель завершился: " + err.Error()
		}
		a.writeState(latest)
	}()
	return map[string]any{"started": true, "status": a.status()}, nil
}

func (a *app) stop() map[string]any {
	state := a.readState()
	stopped := false
	if state.PID > 0 && processAlive(state.PID) {
		if err := terminatePID(state.PID); err == nil {
			stopped = true
		}
	}
	state.PID = 0
	state.SocksReady = false
	state.Error = ""
	a.writeState(state)
	return map[string]any{"stopped": stopped, "status": a.status()}
}

func hasArg(args []string, name string) bool {
	for _, arg := range args {
		if arg == name || strings.HasPrefix(arg, name+"=") {
			return true
		}
	}
	return false
}

func needsElevatedLog(args []string) bool {
	for i, arg := range args {
		if arg == "-mode" && i+1 < len(args) {
			return args[i+1] == "wg" || args[i+1] == "rawsystem"
		}
		if strings.HasPrefix(arg, "-mode=") {
			mode := strings.TrimPrefix(arg, "-mode=")
			return mode == "wg" || mode == "rawsystem"
		}
	}
	return false
}

func chooseInt(condition bool, yes, no int) int {
	if condition {
		return yes
	}
	return no
}

func tailFile(path string, count int) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return []string{}
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	clean := lines[:0]
	for _, line := range lines {
		if line != "" {
			clean = append(clean, line)
		}
	}
	return tailSlice(clean, count)
}

func tailSlice(lines []string, count int) []string {
	if count < 0 {
		count = 0
	}
	if len(lines) <= count {
		return lines
	}
	return lines[len(lines)-count:]
}

func checkIP(payload checkPayload) (map[string]any, error) {
	host := payload.Socks.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := payload.Socks.Port
	if port == 0 {
		port = 1080
	}
	targets := []struct {
		host string
		path string
		json bool
	}{
		{"api.ipify.org", "/?format=json", true},
		{"ifconfig.me", "/ip", false},
		{"icanhazip.com", "/", false},
	}
	started := time.Now()
	var lastErr error
	for _, target := range targets {
		body, err := getHTTPSViaSocks(host, port, payload.Socks.User, payload.Socks.Pass, target.host, target.path)
		if err != nil {
			lastErr = err
			continue
		}
		ip := strings.TrimSpace(body)
		if target.json {
			var value struct {
				IP string `json:"ip"`
			}
			if err := json.Unmarshal([]byte(body), &value); err != nil {
				lastErr = err
				continue
			}
			ip = strings.TrimSpace(value.IP)
		}
		if net.ParseIP(ip) == nil {
			lastErr = fmt.Errorf("некорректный IP в ответе %s", target.host)
			continue
		}
		return map[string]any{"ip": ip, "provider": target.host, "ms": time.Since(started).Milliseconds()}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("не удалось проверить IP")
	}
	return nil, lastErr
}

func getHTTPSViaSocks(socksHost string, socksPort int, username, password, targetHost, path string) (string, error) {
	dialer := net.Dialer{Timeout: 12 * time.Second}
	conn, err := dialer.Dial("tcp", net.JoinHostPort(socksHost, strconv.Itoa(socksPort)))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(18 * time.Second))

	methods := []byte{0x00}
	if username != "" {
		methods = append(methods, 0x02)
	}
	if _, err := conn.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return "", err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return "", err
	}
	if reply[0] != 0x05 || reply[1] == 0xff {
		return "", errors.New("SOCKS5: способ авторизации отклонён")
	}
	if reply[1] == 0x02 {
		if len(username) > 255 || len(password) > 255 {
			return "", errors.New("SOCKS5: слишком длинный логин или пароль")
		}
		auth := []byte{0x01, byte(len(username))}
		auth = append(auth, []byte(username)...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, []byte(password)...)
		if _, err := conn.Write(auth); err != nil {
			return "", err
		}
		if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0x00 {
			return "", errors.New("SOCKS5: ошибка авторизации")
		}
	}

	if len(targetHost) > 255 {
		return "", errors.New("SOCKS5: имя хоста слишком длинное")
	}
	connect := []byte{0x05, 0x01, 0x00, 0x03, byte(len(targetHost))}
	connect = append(connect, []byte(targetHost)...)
	connect = append(connect, 0x01, 0xbb) // 443
	if _, err := conn.Write(connect); err != nil {
		return "", err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return "", err
	}
	if head[1] != 0x00 {
		return "", fmt.Errorf("SOCKS5 CONNECT: код %d", head[1])
	}
	var addressBytes int
	switch head[3] {
	case 0x01:
		addressBytes = 4
	case 0x04:
		addressBytes = 16
	case 0x03:
		length := []byte{0}
		if _, err := io.ReadFull(conn, length); err != nil {
			return "", err
		}
		addressBytes = int(length[0])
	default:
		return "", errors.New("SOCKS5: неизвестный тип адреса")
	}
	if _, err := io.CopyN(io.Discard, conn, int64(addressBytes+2)); err != nil {
		return "", err
	}

	secure := tls.Client(conn, &tls.Config{ServerName: targetHost, MinVersion: tls.VersionTLS12})
	if err := secure.Handshake(); err != nil {
		return "", err
	}
	request, _ := http.NewRequest(http.MethodGet, "https://"+targetHost+path, nil)
	request.Header.Set("User-Agent", "qWDTT-Chrome/1.1")
	request.Header.Set("Accept", "application/json, text/plain, */*")
	request.Header.Set("Connection", "close")
	if err := request.Write(secure); err != nil {
		return "", err
	}
	responseValue, err := http.ReadResponse(bufio.NewReader(secure), request)
	if err != nil {
		return "", err
	}
	defer responseValue.Body.Close()
	if responseValue.StatusCode < 200 || responseValue.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", responseValue.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(responseValue.Body, 64*1024))
	return string(body), err
}
