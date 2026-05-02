/* Shim header for mingw cross-compile of webview_go.
   WebView2.h needs EventToken.h which is normally provided by the Windows SDK;
   mingw-w64 doesn't ship it. The struct is trivial — see Microsoft's docs. */
#ifndef _EVENTTOKEN_H_
#define _EVENTTOKEN_H_
typedef struct EventRegistrationToken { __int64 value; } EventRegistrationToken;
#endif
