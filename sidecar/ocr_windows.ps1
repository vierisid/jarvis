param([Parameter(Mandatory=$true)][string]$Path)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Fail($msg) {
    [Console]::Error.WriteLine("ocr_windows.ps1: $msg")
    exit 1
}

try {
    if (-not (Test-Path -LiteralPath $Path)) {
        Fail "image not found: $Path"
    }
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath

    # Load WinRT types we need. The Out-Null pattern primes the type cache so
    # subsequent [Type]::method calls resolve.
    [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    # PowerShell can't directly await WinRT IAsyncOperation<T>; bridge via
    # WindowsRuntimeSystemExtensions.AsTask<T> and Task.Wait().
    $allAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }
    if (-not $allAsTask) {
        Fail "WindowsRuntimeSystemExtensions.AsTask not found -- needs PowerShell 5.1 on Windows 10 or later"
    }
    $asTaskGeneric = @($allAsTask)[0]

    function Await($task, $resultType) {
        if ($null -eq $task) { throw "Await received null task for $($resultType.FullName)" }
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $netTask = $asTask.Invoke($null, @($task))
        if ($null -eq $netTask) { throw "AsTask returned null for $($resultType.FullName)" }
        $netTask.Wait(-1) | Out-Null
        if ($netTask.IsFaulted) {
            throw "Task faulted for $($resultType.FullName): $($netTask.Exception.InnerException.Message)"
        }
        return $netTask.Result
    }

    $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved))      ([Windows.Storage.StorageFile])
    $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))             ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))      ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = Await ($decoder.GetSoftwareBitmapAsync())                                   ([Windows.Graphics.Imaging.SoftwareBitmap])

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        # Fall back to the highest-quality installed OCR language regardless of
        # user-profile preference. Useful on systems where the user's display
        # language is not OCR-capable.
        $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
        if (-not $langs -or $langs.Count -eq 0) {
            Fail "no OCR language packs installed. Add one in Windows Settings under Time and Language, Language, then add a language with the Optical character recognition optional feature."
        }
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0])
        if ($null -eq $engine) {
            Fail "could not create OCR engine for any installed language"
        }
    }

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    if ($null -eq $result) { Fail "RecognizeAsync returned null" }

    $text = if ($null -eq $result.Text) { "" } else { $result.Text }

    @{ text = $text } | ConvertTo-Json -Compress
}
catch {
    Fail "$($_.Exception.Message)"
}
