If using the provider along with yt-dlp as intended, stop reading here. The server and script will be used automatically with no intervention required.

If you are interested in using the script/server standalone for generating your own PO token, read onwards.

> [!CAUTION] 
> These endpoints and options are **unstable** and may change without notice.

# Server

**Endpoints**

- **POST /get_pot**: Generate a new POT.
    - The request data should be a JSON including:
        - `content_binding`: [Content binding](#content-binding) (optional, set to visitor data in `innertube_context` or a freshly generated visitor data if null).
        - `proxy`: A string indicating the proxy to use for the requests (optional).
        - `bypass_cache`: boolean, when set to true, bypasses any cache if present (optional).
        - `challenge`: string or null, the BotGuard challenge from Innertube (optional).
        - `disable_tls_verification`: boolean, when set to true, disables TLS certificate verification. (optional)
        - `innertube_context`: object, the innertube context to be sent in the innertube request in case `challenge` is not present. Note that when available, the public IP in the innertube context is used as the cache key for POTs. (optional)
        - `source_address`: string, the cient-side IP address to bind to. (optional)
    - Returns a JSON:
        - `poToken`: The POT.
        - `contentBinding`: The generated or passed [content binding](#content-binding).
        - `expiresAt`: The expiry timestamp of the POT entry.
- **GET /ping**: Ping the server. The response includes:
    - `server_uptime`: Uptime of the server process in seconds.
    - `version`: Current server version.

# Script Method

**Options**

- `-c, --content-binding <content-binding>`: The [content binding](#content-binding), optional.
- `-p, --proxy <proxy-all>`: The proxy to use for the requests, optional.
- `-b, --bypass-cache`: See `bypass_cache` from the `POST /get_pot` endpoint.
- `-s, --source-address <source-address>`: See `source_address` from the `POST /get_pot` endpoint, optional.
- `--innertube-context <innertube-context>`: See `innertube_context` from the `POST /get_pot` endpoint, optional.
- `--disable-tls-verification`: See `disable_tls_verification` from the above endpoint.
- `--version`: Print the script version and exit.
- `--verbose`: Use verbose logging.

**Environment Variables**

- **TOKEN_TTL**: The time in hours for a PO token to be considered valid. While there are no definitive answers on how long a token is valid, it has been observed to be valid for at least a couple of days (Default: 6).

### Content Binding

Content bindings refer to the data used to generate a PO Token.

GVS WEBPO tokens (See [PO Tokens for GVS](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide#po-tokens-for-gvs) from the PO Token Guide) used to be session-bound so the content binding for a GVS token is either a Visitor ID (also known as `visitorData`, `VISITOR_INFO1_LIVE`, used when not logged in) or the account Session ID (first part of the Data Sync ID, used when logged in). They are mostly bound to video ID now.

Player tokens are mostly content-bound and their content bindings are the video IDs. Note that the `web_music` client uses the session token instead of video ID to generate player tokens.
```shell
# Replace 2.0.1 with the latest version or the one that matches the plugin
git clone --single-branch --branch 2.0.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server/
# If you are using Node:
npm ci
npx tsc
# Otherwise, if you want to use Deno:
deno install --allow-scripts=npm:canvas --frozen
```

#### (a) HTTP Server Option

This is a JavaScript HTTP server on port 4416 by default. When run natively, it binds to localhost only (`127.0.0.1` / `::1`). You have two options for running it: as a prebuilt Docker image, or manually as a JavaScript application.

**Docker:**

The Docker image binds the server to all interfaces inside the container so that port forwarding works. Publish it only to the host's IPv4 loopback interface:

```shell
docker run --name bgutil-provider -d --init \
  -p 127.0.0.1:4416:4416 brainicism/bgutil-ytdlp-pot-provider
```

> [!WARNING]
> Omitting `127.0.0.1` from the port mapping publishes the server on all host interfaces by default. This may allow untrusted local or external clients to access the unauthenticated server, generate tokens, consume system and network resources and potentially perform RCE.

Our Docker image comes in two flavors: Node.js or Deno. The `:latest` tag defaults to Node.js, but you can specify an alternate version/flavor like so: `brainicism/bgutil-ytdlp-pot-provider:2.0.1-deno`. The `:node` tag also points to the latest Node.js image, and `:deno` points to the latest Deno image.

> [!IMPORTANT]
> Note that the docker container's network is isolated from your local network by default. If you are using a local proxy server, it will not be accessible from within the container unless you pass `--net=host` as well.

**Native:**

Run the server with the selected JavaScript runtime with the following command, assuming you have changed into the `bgutil-ytdlp-pot-provider/server` directory. Replace `[OPTIONS]` with the server command line options. For example, replace it with `--port 8080` to run the server on port 8080.

Node:

```shell
node build/main.js [OPTIONS]
```

Deno:

```shell
cd node_modules
deno run --allow-env --allow-net --allow-ffi=. --allow-read=. ../src/main.ts [OPTIONS]
```

**Server Command Line Options**

- `-p, --port <PORT>`: The port on which the server listens.
- `-H, --host <HOST>`: Host/IP to listen on. Repeat it or separate values with commas to bind multiple addresses. Defaults to localhost only (`127.0.0.1` and `::1`).

#### (b) Generation Script Option

> [!IMPORTANT]
> This method is NOT recommended for high concurrency usage. Every yt-dlp call incurs the overhead of spawning a new Node.js process to run the script. This method also handles cache concurrency poorly.

For this option, just make sure either `node` or `deno` is available in your `PATH`. Otherwise, use the yt-dlp option `--js-runtimes RUNTIME:PATH` to pass the path. `--no-js-runtimes` does NOT prevent the plugin from using the JavaScript runtime. The argument is only used to retrieve the path to the runtime.

### 2. Install the plugin

#### PyPI:

If yt-dlp is installed through `pip` or `pipx`, you can install the plugin with the following:

```shell
python3 -m pip install -U bgutil-ytdlp-pot-provider
```

#### Manual:

1. Download [`bgutil-ytdlp-pot-provider.zip`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip) from [the latest release](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest).
2. Install it by placing the zip into one of the [yt-dlp plugin folders](https://github.com/yt-dlp/yt-dlp#installing-plugins).

## Usage

If using option (a) HTTP Server for the provider, and the default IP/port number (http://127.0.0.1:4416), you can use yt-dlp like normal 🙂.

If the provider server is reachable at a different URL, pass it to yt-dlp via `base_url`:

```shell
--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:8080"
```

Note that when you pass multiple extractor arguments to one provider or extractor, they are to be separated by semicolons(`;`) as shown above.

---

If using option (b) script for the provider, with the default script location in your home directory (i.e: `~/bgutil-ytdlp-pot-provider` or `%USERPROFILE%\bgutil-ytdlp-pot-provider`), you can also use yt-dlp like normal.

If you installed the script in a different location, pass it as the extractor argument `server_home` to `youtube-bgutilscript` for each yt-dlp call. `~` at the start of the path is automatically expanded.

```shell
--extractor-args "youtubepot-bgutilscript:server_home=/path/to/bgutil-ytdlp-pot-provider/server"
```

---

We use a cache internally for all generated tokens when option (b) script is used. You can change the TTL (time to live) for the token cache with the environment variable `TOKEN_TTL` (in hours, defaults to 6). It's currently impossible to use different TTLs for different token contexts (can be `gvs`, `player`, or `subs`, see [Technical Details](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide#technical-details) from the PO Token Guide).  
That is, when using the script method, you can pass a `TOKEN_TTL` to yt-dlp to use a custom TTL for PO Tokens.

---

If both methods are available for use, the option (a) HTTP server method will be prioritized.

### Verification

To check if the plugin was installed correctly, you should see the `bgutil` providers in yt-dlp's verbose output: `yt-dlp -v YOUTUBE_URL`.

```
[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.1 (external), bgutil:script-node-2.0.1 (external), bgutil:script-deno-2.0.1 (external, unavailable)
```

This only confirms that yt-dlp loaded the plugin. To confirm that a PO Token was actually requested and generated, also look for a line like one of these in the same output:

```
[youtube] [pot:bgutil:http] Generating a gvs PO Token for web client via bgutil HTTP server
[youtube] [pot:bgutil:script-node] Generating a gvs PO Token for web client via bgutil script
```

(the context and client may differ, e.g. `player` instead of `gvs`, or `tv` instead of `web`).

If the providers are listed but no `Generating a ... PO Token` line ever appears, the PO Token flow was never triggered. This usually means the selected player clients failed earlier (e.g. with `LOGIN_REQUIRED`) before reaching a step that needs a PO Token, so the provider itself is not the problem. Try a different set of player clients, for example:

```shell
--extractor-args "youtube:player-client=mweb,tv,web_safari"
```

Also note that a PO Token does not bypass IP-based login restrictions. If you still get "Sign in to confirm you're not a bot" after a token was generated (common on datacenter IPs), you additionally need to pass cookies; see #37.

### FAQ

#### I'm getting errors during `npm ci` on Termux

For provider versions >=1.2.0, you may have issues while installing the `canvas` dependency on Termux. The Termux environment is missing a `android_ndk_path` and two packages by default. Run the following commands to setup the dependencies correctly.

```shell
mkdir ~/.gyp && echo "{'variables':{'android_ndk_path':''}}" > ~/.gyp/include.gypi
pkg install libvips xorgproto
```
