"""Static dev server with caching disabled (browsers cache ES modules aggressively).

Usage:  python serve.py [port]      → http://localhost:5173
Any static server works too: `python -m http.server`, `npx serve .`
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.json': 'application/json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    print(f'CQA frontend: http://localhost:{port}  (mock: ?mock=1, real API: ?mock=0, demo: ?demo=1)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
