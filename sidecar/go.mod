module github.com/jarvis/sidecar

go 1.25.0

require (
	github.com/gen2brain/malgo v0.11.24
	github.com/go-ole/go-ole v1.3.0
	github.com/google/uuid v1.6.0
	github.com/hajimehoshi/go-mp3 v0.3.4
	github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6
	golang.org/x/image v0.39.0
	golang.org/x/sys v0.46.0
	gopkg.in/yaml.v3 v3.0.1
	nhooyr.io/websocket v1.8.17
)

replace github.com/webview/webview_go => ./third_party/webview_go
