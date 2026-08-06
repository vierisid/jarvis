//go:build windows

package main

// Authenticode verification of the staged jarvis.exe before it's installed:
// WinVerifyTrust for chain validity + an optional publisher pin, because a
// chain-valid signature alone would accept ANY signed executable.

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// expectedPublisherCN pins the Authenticode signer's subject CN (the company
// name on the OV certificate); stamped at release with
// -X main.expectedPublisherCN=<CN>. Empty (dev builds) verifies the chain
// only, with a loud warning.
var expectedPublisherCN = ""

var (
	wintrust                = windows.NewLazySystemDLL("wintrust.dll")
	procWinVerifyTrust      = wintrust.NewProc("WinVerifyTrust")
	wintrustActionGenericV2 = windows.GUID{Data1: 0xaac56b, Data2: 0xcd44, Data3: 0x11d0, Data4: [8]byte{0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee}}
)

const (
	wtdUInone            = 2
	wtdChoiceFile        = 1
	wtdStateActionVerify = 1
	wtdStateActionClose  = 2

	// fdwRevocationChecks values.
	wtdRevokeNone = 0

	// dwProvFlags values. Revocation is not fetched over the network: the
	// machine may be offline mid-install, and the sha512 pin against the
	// registry already anchors which build we accept.
	wtdRevocationCheckNone = 0x10
	wtdCacheOnlyURLRetriev = 0x1000
)

type winTrustFileInfo struct {
	cbStruct       uint32
	pcwszFilePath  *uint16
	hFile          uintptr
	pgKnownSubject *windows.GUID
}

type winTrustData struct {
	cbStruct            uint32
	pPolicyCallbackData uintptr
	pSIPClientData      uintptr
	dwUIChoice          uint32
	fdwRevocationChecks uint32
	dwUnionChoice       uint32
	pFile               *winTrustFileInfo
	dwStateAction       uint32
	hWVTStateData       uintptr
	pwszURLReference    *uint16
	dwProvFlags         uint32
	dwUIContext         uint32
	pSignatureSettings  uintptr
}

// verifyPayloadSignature validates the Authenticode signature on the staged
// exe. Revocation is checked from cache only — the machine may be offline mid
// install, and the sha512 pin against the registry already anchors freshness.
func verifyPayloadSignature(stagedBin string) error {
	exe := filepath.Join(stagedBin, sidecarExeName)

	pathW, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	fileInfo := winTrustFileInfo{pcwszFilePath: pathW}
	fileInfo.cbStruct = uint32(unsafe.Sizeof(fileInfo))
	data := winTrustData{
		dwUIChoice:          wtdUInone,
		fdwRevocationChecks: wtdRevokeNone,
		dwUnionChoice:       wtdChoiceFile,
		pFile:               &fileInfo,
		dwStateAction:       wtdStateActionVerify,
		dwProvFlags:         wtdRevocationCheckNone | wtdCacheOnlyURLRetriev,
	}
	data.cbStruct = uint32(unsafe.Sizeof(data))

	ret, _, _ := procWinVerifyTrust.Call(0, uintptr(unsafe.Pointer(&wintrustActionGenericV2)), uintptr(unsafe.Pointer(&data)))
	// Always release the state handle.
	data.dwStateAction = wtdStateActionClose
	procWinVerifyTrust.Call(0, uintptr(unsafe.Pointer(&wintrustActionGenericV2)), uintptr(unsafe.Pointer(&data)))

	if ret != 0 {
		return fmt.Errorf("WinVerifyTrust refused the signature (0x%x)", ret)
	}

	if expectedPublisherCN == "" {
		logf("warning: no pinned publisher in this installer build — verifying signature chain only")
		return nil
	}
	// Publisher pin: chain validity alone would accept ANY signed executable,
	// so compare the signer's CN. PowerShell is guaranteed present on
	// supported Windows; native CryptQueryObject plumbing is deferred.
	// Single-quoted PS literal (embedded ' doubled): unlike double quotes it
	// expands neither $ nor backticks, which are legal in Windows paths.
	psPath := "'" + strings.ReplaceAll(exe, "'", "''") + "'"
	ps := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-AuthenticodeSignature -FilePath "+psPath+").SignerCertificate.Subject")
	hideSubprocessWindow(ps)
	out, err := ps.Output()
	if err != nil {
		return fmt.Errorf("could not read signer certificate: %v", err)
	}
	subject := strings.TrimSpace(string(out))
	cn, ok := subjectCN(subject)
	if !ok {
		return fmt.Errorf("signer subject %q has no CN", subject)
	}
	// Exact match on the parsed CN — a substring test would also pass a
	// certificate that merely embeds the pin in some other RDN.
	if !strings.EqualFold(cn, expectedPublisherCN) {
		return fmt.Errorf("signer CN %q does not match pinned publisher %q", cn, expectedPublisherCN)
	}
	return nil
}
