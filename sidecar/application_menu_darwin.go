//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

// Programmatic AppKit applications do not receive the standard application
// menu that a storyboard/nib normally creates. WKWebView's editable controls
// implement cut/copy/paste/select-all through the responder chain, but macOS
// only turns Command-X/C/V/A into those actions when matching key equivalents
// exist in NSApp.mainMenu. Without this hidden Edit menu, the first-run token
// field accepts typing but Command-V appears to do nothing.

static void jarvisAddEditCommand(NSMenu* menu, NSString* title, SEL action,
                                 NSString* key, NSEventModifierFlags modifiers) {
    NSMenuItem* item = [[NSMenuItem alloc]
        initWithTitle:title action:action keyEquivalent:key];
    item.target = nil; // nil routes the action through the active responder chain
    item.keyEquivalentModifierMask = modifiers;
    [menu addItem:item];
}

// Identify an existing Edit-equivalent menu by responder-chain actions, not
// its display title. macOS localizes "Edit", and embedding hosts can choose a
// different title while still providing the standard commands. All four core
// commands must be present somewhere in the menu bar — a partial menu (say,
// copy without paste) must not suppress installing the full set.
static BOOL jarvisHasEditMenu(NSMenu* mainMenu) {
    BOOL hasCut = NO, hasCopy = NO, hasPaste = NO, hasSelectAll = NO;
    for (NSMenuItem* item in mainMenu.itemArray) {
        NSMenu* submenu = item.submenu;
        if (submenu == nil) {
            continue;
        }
        for (NSMenuItem* command in submenu.itemArray) {
            SEL action = command.action;
            if (action == @selector(cut:)) hasCut = YES;
            else if (action == @selector(copy:)) hasCopy = YES;
            else if (action == @selector(paste:)) hasPaste = YES;
            else if (action == @selector(selectAll:)) hasSelectAll = YES;
        }
    }
    return hasCut && hasCopy && hasPaste && hasSelectAll;
}

static void jarvisInstallApplicationMenusOnMain(void) {
    [NSApplication sharedApplication];

    NSMenu* mainMenu = NSApp.mainMenu;
    if (mainMenu == nil) {
        mainMenu = [[NSMenu alloc] initWithTitle:@""];
        NSApp.mainMenu = mainMenu;
    }
    if (jarvisHasEditMenu(mainMenu)) {
        return; // app bundle or another window already supplied one
    }

    // AppKit renders item 0 of the main menu as the application menu (the bold
    // app-name menu). The menu bar is visible whenever the activation policy is
    // Regular — the vendored webview raises it for the first-run window — so
    // keep a placeholder in slot 0 or the Edit commands would render under the
    // app name.
    if (mainMenu.numberOfItems == 0) {
        NSMenuItem* appRoot = [[NSMenuItem alloc]
            initWithTitle:@"" action:nil keyEquivalent:@""];
        appRoot.submenu = [[NSMenu alloc] initWithTitle:@""];
        [mainMenu addItem:appRoot];
    }

    NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    jarvisAddEditCommand(editMenu, @"Undo", @selector(undo:), @"z",
                         NSEventModifierFlagCommand);
    jarvisAddEditCommand(editMenu, @"Redo", @selector(redo:), @"z",
                         NSEventModifierFlagCommand | NSEventModifierFlagShift);
    [editMenu addItem:[NSMenuItem separatorItem]];
    jarvisAddEditCommand(editMenu, @"Cut", @selector(cut:), @"x",
                         NSEventModifierFlagCommand);
    jarvisAddEditCommand(editMenu, @"Copy", @selector(copy:), @"c",
                         NSEventModifierFlagCommand);
    jarvisAddEditCommand(editMenu, @"Paste", @selector(paste:), @"v",
                         NSEventModifierFlagCommand);
    jarvisAddEditCommand(editMenu, @"Select All", @selector(selectAll:), @"a",
                         NSEventModifierFlagCommand);

    NSMenuItem* editRoot = [[NSMenuItem alloc]
        initWithTitle:@"Edit" action:nil keyEquivalent:@""];
    editRoot.submenu = editMenu;
    [mainMenu addItem:editRoot];
}

static void jarvisInstallApplicationMenus(void) {
    // tray_darwin.go pins main() to the process's main OS thread in init().
    // Install synchronously so Command-X/C/V/A exist before startup can create
    // or focus the first WKWebView token field.
    jarvisInstallApplicationMenusOnMain();
}
*/
import "C"

func installApplicationMenus() {
	C.jarvisInstallApplicationMenus()
}
