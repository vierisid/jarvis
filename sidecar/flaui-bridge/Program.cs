using System;
using System.IO;
using System.Text.Json;

namespace FLAUIBridge;

class Program
{
    static void Main(string[] args)
    {
        Console.Error.WriteLine("[flaui-bridge] Starting FlaUI bridge...");

        using var server = new BridgeServer();

        // Line-based JSON-RPC over stdin/stdout
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            string id = "";
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";
                var method = root.TryGetProperty("method", out var mProp) ? mProp.GetString() ?? "" : "";
                JsonElement? parameters = root.TryGetProperty("params", out var pProp) ? pProp : null;

                var result = server.HandleRequest(method, parameters);
                var response = JsonSerializer.Serialize(new { id, result }, BridgeServer.JsonOpts);
                Console.WriteLine(response);
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                var errResponse = JsonSerializer.Serialize(new { id, error = ex.Message }, BridgeServer.JsonOpts);
                Console.WriteLine(errResponse);
                Console.Out.Flush();
                Console.Error.WriteLine($"[flaui-bridge] Error: {ex.Message}");
            }
        }

        Console.Error.WriteLine("[flaui-bridge] Stdin closed, exiting.");
    }
}
