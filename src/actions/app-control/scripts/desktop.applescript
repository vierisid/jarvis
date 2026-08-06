-- Jarvis desktop helper — macOS fallback path (no sidecar).
--
-- Invoked as:
--   osascript desktop.applescript <command> [args...]
--
-- All user-supplied values arrive as argv items and are never spliced into
-- script source. osascript reports handler errors on stderr and exits
-- non-zero, which the caller (macos.ts) turns into thrown errors.
--
-- Window lines are tab-separated: pid, focused(1/0), x, y, width, height,
-- className (process name), title. Title comes last.

on run argv
	if (count of argv) < 1 then error "Missing command"
	set cmd to item 1 of argv
	if cmd is "get-active-window" then
		return activeWindowLine()
	else if cmd is "list-windows" then
		return listWindowLines()
	else if cmd is "focus-window" then
		focusPid((item 2 of argv) as integer)
	else if cmd is "type-text" then
		typeText(item 2 of argv)
	else if cmd is "press-keys" then
		pressKeys(item 2 of argv, item 3 of argv, item 4 of argv)
	else if cmd is "click-at" then
		clickAt((item 2 of argv) as integer, (item 3 of argv) as integer)
	else
		error "Unknown command: " & cmd
	end if
	return ""
end run

on windowLine(procPid, procName, isFocused, win)
	tell application "System Events"
		set winTitle to name of win
		set {xPos, yPos} to position of win
		set {winWidth, winHeight} to size of win
	end tell
	set focusedText to "0"
	if isFocused then set focusedText to "1"
	if winTitle is missing value then set winTitle to ""
	return (procPid as text) & tab & focusedText & tab & (xPos as text) & tab & (yPos as text) & tab & (winWidth as text) & tab & (winHeight as text) & tab & procName & tab & winTitle
end windowLine

on activeWindowLine()
	tell application "System Events"
		set frontProc to first application process whose frontmost is true
		set procName to name of frontProc
		set procPid to unix id of frontProc
		set wins to windows of frontProc
		if (count of wins) is 0 then error "Frontmost application has no windows"
		set win to item 1 of wins
	end tell
	return my windowLine(procPid, procName, true, win)
end activeWindowLine

on listWindowLines()
	set out to {}
	tell application "System Events"
		set frontPid to unix id of (first application process whose frontmost is true)
		repeat with proc in (application processes whose background only is false)
			set procPid to unix id of proc
			set procName to name of proc
			repeat with win in (windows of proc)
				try
					set end of out to my windowLine(procPid, procName, procPid is frontPid, win)
				end try
			end repeat
		end repeat
	end tell
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set joined to out as text
	set AppleScript's text item delimiters to savedDelims
	return joined
end listWindowLines

on focusPid(thePid)
	tell application "System Events"
		set targetProc to first application process whose unix id is thePid
		set frontmost of targetProc to true
	end tell
end focusPid

on typeText(theText)
	tell application "System Events" to keystroke theText
end typeText

-- modsCsv: comma-separated subset of command/option/control/shift, or "-".
-- kind: "code" (value is a numeric key code) or "char" (value is a literal
-- character for keystroke). The caller maps key names to codes.
on pressKeys(modsCsv, kind, keyValue)
	tell application "System Events"
		set mods to {}
		if modsCsv contains "command" then set end of mods to command down
		if modsCsv contains "option" then set end of mods to option down
		if modsCsv contains "control" then set end of mods to control down
		if modsCsv contains "shift" then set end of mods to shift down
		if kind is "code" then
			if (count of mods) is 0 then
				key code (keyValue as integer)
			else
				key code (keyValue as integer) using mods
			end if
		else
			if (count of mods) is 0 then
				keystroke keyValue
			else
				keystroke keyValue using mods
			end if
		end if
	end tell
end pressKeys

on clickAt(xPos, yPos)
	tell application "System Events"
		tell (first application process whose frontmost is true)
			click at {xPos, yPos}
		end tell
	end tell
end clickAt
