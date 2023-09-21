import { Transport } from "../transport.js";
import debugModule from "debug"; // debug()
import { yeast } from "../contrib/yeast.js";
import { encode } from "../contrib/parseqs.js";
import { encodePayload, decodePayload, RawData } from "engine.io-parser";
import {
  CookieJar,
  createCookieJar,
  XHR as XMLHttpRequest,
} from "./xmlhttprequest.js";
import { Emitter } from "@socket.io/component-emitter";
import { SocketOptions } from "../socket.js";
import { installTimerFunctions, pick } from "../util.js";
import { globalThisShim as globalThis } from "../globalThis.js";

const debug = debugModule("engine.io-client:polling"); // debug()

function empty() {}

const hasXHR2 = (function () {
  const xhr = new XMLHttpRequest({
    xdomain: false,
  });
  return null != xhr.responseType;
})();

export class Polling extends Transport {
  private readonly xd: boolean;

  private polling: boolean = false;
  private pollXhr: any;
  private cookieJar?: CookieJar;

  /**
   * XHR Polling constructor.
   *
   * @param {Object} opts
   * @package
   */
  constructor(opts) {
    super(opts);

    if (typeof location !== "undefined") {
      const isSSL = "https:" === location.protocol;
      let port = location.port;

      // some user agents have empty `location.port`
      if (!port) {
        port = isSSL ? "443" : "80";
      }

      this.xd =
        (typeof location !== "undefined" &&
          opts.hostname !== location.hostname) ||
        port !== opts.port;
    }
    /**
     * XHR supports binary
     */
    const forceBase64 = opts && opts.forceBase64;
    this.supportsBinary = hasXHR2 && !forceBase64;

    if (this.opts.withCredentials) {
      this.cookieJar = createCookieJar();
    }
  }

  override get name() {
    return "polling";
  }

  /**
   * Opens the socket (triggers polling). We write a PING message to determine
   * when the transport is open.
   *
   * @protected
   */
  override doOpen() {
    this.poll();
  }

  /**
   * Pauses polling.
   *
   * @param {Function} onPause - callback upon buffers are flushed and transport is paused
   * @package
   */
  override pause(onPause) {
    this.readyState = "pausing";

    const pause = () => {
      debug("paused");
      this.readyState = "paused";
      onPause();
    };

    if (this.polling || !this.writable) {
      let total = 0;

      if (this.polling) {
        debug("we are currently polling - waiting to pause");
        total++;
        this.once("pollComplete", function () {
          debug("pre-pause polling complete");
          --total || pause();
        });
      }

      if (!this.writable) {
        debug("we are currently writing - waiting to pause");
        total++;
        this.once("drain", function () {
          debug("pre-pause writing complete");
          --total || pause();
        });
      }
    } else {
      pause();
    }
  }

  /**
   * Starts polling cycle.
   *
   * @private
   */
  poll() {
    debug("polling");
    this.polling = true;
    this.doPoll();
    this.emitReserved("poll");
  }

  /**
   * Overloads onData to detect payloads.
   *
   * @protected
   */
  override onData(data) {
    debug("polling got data %s", data);
    const callback = (packet) => {
      // if its the first message we consider the transport open
      if ("opening" === this.readyState && packet.type === "open") {
        this.onOpen();
      }

      // if its a close packet, we close the ongoing requests
      if ("close" === packet.type) {
        this.onClose({ description: "transport closed by the server" });
        return false;
      }

      // otherwise bypass onData and handle the message
      this.onPacket(packet);
    };

    // decode payload
    decodePayload(data, this.socket.binaryType).forEach(callback);

    // if an event did not trigger closing
    if ("closed" !== this.readyState) {
      // if we got data we're not polling
      this.polling = false;
      this.emitReserved("pollComplete");

      if ("open" === this.readyState) {
        this.poll();
      } else {
        debug('ignoring poll - transport state "%s"', this.readyState);
      }
    }
  }

  /**
   * For polling, send a close packet.
   *
   * @protected
   */
  override doClose() {
    const close = () => {
      debug("writing close packet");
      this.write([{ type: "close" }]);
    };

    if ("open" === this.readyState) {
      debug("transport open - closing");
      close();
    } else {
      // in case we're trying to close while
      // handshaking is in progress (GH-164)
      debug("transport not open - deferring close");
      this.once("open", close);
    }
  }

  /**
   * Writes a packets payload.
   *
   * @param {Array} packets - data packets
   * @protected
   */
  override write(packets) {
    this.writable = false;

    encodePayload(packets, (data) => {
      this.doWrite(data, () => {
        this.writable = true;
        this.emitReserved("drain");
      });
    });
  }

  /**
   * Generates uri for connection.
   *
   * @private
   */
  private uri() {
    const schema = this.opts.secure ? "https" : "http";
    const query: { b64?: number; sid?: string } = this.query || {};

    // cache busting is forced
    if (false !== this.opts.timestampRequests) {
      query[this.opts.timestampParam] = yeast();
    }

    if (!this.supportsBinary && !query.sid) {
      query.b64 = 1;
    }

    return this.createUri(schema, query);
  }

  /**
   * Creates a request.
   *
   * @param {String} method
   * @private
   */
  request(opts = {}) {
    Object.assign(opts, { xd: this.xd, cookieJar: this.cookieJar }, this.opts);
    return new Request(this.uri(), opts);
  }

  /**
   * Sends data.
   *
   * @param {String} data to send.
   * @param {Function} called upon flush.
   * @private
   */
  private doWrite(data, fn) {
    const req = this.request({
      method: "POST",
      data: data,
    });
    req.on("success", fn);
    req.on("error", (xhrStatus, context) => {
      this.onError("xhr post error", xhrStatus, context);
    });
  }

  /**
   * Starts a poll cycle.
   *
   * @private
   */
  private doPoll() {
    debug("xhr poll");
    const req = this.request();
    req.on("data", this.onData.bind(this));
    req.on("error", (xhrStatus, context) => {
      this.onError("xhr poll error", xhrStatus, context);
    });
    this.pollXhr = req;
  }
}

interface RequestReservedEvents {
  success: () => void;
  data: (data: RawData) => void;
  error: (err: number | Error, context: unknown) => void; // context should be typed as XMLHttpRequest, but this type is not available on non-browser platforms
}

export class Request extends Emitter<{}, {}, RequestReservedEvents> {
  private readonly opts: { xd; cookieJar: CookieJar } & SocketOptions;
  private readonly method: string;
  private readonly uri: string;
  private readonly data: string | ArrayBuffer;

  private xhr: any;
  private setTimeoutFn: typeof setTimeout;
  private index: number;

  static requestsCount = 0;
  static requests = {};

  /**
   * Request constructor
   *
   * @param {Object} options
   * @package
   */
  constructor(uri, opts) {
    super();
    installTimerFunctions(this, opts);
    this.opts = opts;

    this.method = opts.method || "GET";
    this.uri = uri;
    this.data = undefined !== opts.data ? opts.data : null;

    this.create();
  }

  /**
   * Creates the XHR object and sends the request.
   *
   * @private
   */
  private create() {
    const opts = pick(
      this.opts,
      "agent",
      "pfx",
      "key",
      "passphrase",
      "cert",
      "ca",
      "ciphers",
      "rejectUnauthorized",
      "autoUnref"
    );
    opts.xdomain = !!this.opts.xd;

    const xhr = (this.xhr = new XMLHttpRequest(opts));

    try {
      debug("xhr open %s: %s", this.method, this.uri);
      xhr.open(this.method, this.uri, true);
      try {
        if (this.opts.extraHeaders) {
          xhr.setDisableHeaderCheck && xhr.setDisableHeaderCheck(true);
          for (let i in this.opts.extraHeaders) {
            if (this.opts.extraHeaders.hasOwnProperty(i)) {
              xhr.setRequestHeader(i, this.opts.extraHeaders[i]);
            }
          }
        }
      } catch (e) {}

      if ("POST" === this.method) {
        try {
          xhr.setRequestHeader("Content-type", "text/plain;charset=UTF-8");
        } catch (e) {}
      }

      try {
        xhr.setRequestHeader("Accept", "*/*");
      } catch (e) {}

      this.opts.cookieJar?.addCookies(xhr);

      // ie6 check
      if ("withCredentials" in xhr) {
        xhr.withCredentials = this.opts.withCredentials;
      }

      if (this.opts.requestTimeout) {
        xhr.timeout = this.opts.requestTimeout;
      }

      if (this.opts.accessToken) {
        xhr.setRequestHeader('Authorization','Bearer ' + this.opts.accessToken);
      }
      
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 3) {
          this.opts.cookieJar?.parseCookies(xhr);
        }

        if (4 !== xhr.readyState) return;
        if (200 === xhr.status || 1223 === xhr.status) {
          this.onLoad();
        } else {
          // make sure the `error` event handler that's user-set
          // does not throw in the same tick and gets caught here
          this.setTimeoutFn(() => {
            this.onError(typeof xhr.status === "number" ? xhr.status : 0);
          }, 0);
        }
      };

      debug("xhr data %s", this.data);
      xhr.send(this.data);
    } catch (e) {
      // Need to defer since .create() is called directly from the constructor
      // and thus the 'error' event can only be only bound *after* this exception
      // occurs.  Therefore, also, we cannot throw here at all.
      this.setTimeoutFn(() => {
        this.onError(e);
      }, 0);
      return;
    }

    if (typeof document !== "undefined") {
      this.index = Request.requestsCount++;
      Request.requests[this.index] = this;
    }
  }

  /**
   * Called upon error.
   *
   * @private
   */
  private onError(err: number | Error) {
    this.emitReserved("error", err, this.xhr);
    this.cleanup(true);
  }

  /**
   * Cleans up house.
   *
   * @private
   */
  private cleanup(fromError?) {
    if ("undefined" === typeof this.xhr || null === this.xhr) {
      return;
    }
    this.xhr.onreadystatechange = empty;

    if (fromError) {
      try {
        this.xhr.abort();
      } catch (e) {}
    }

    if (typeof document !== "undefined") {
      delete Request.requests[this.index];
    }

    this.xhr = null;
  }

  /**
   * Called upon load.
   *
   * @private
   */
  private onLoad() {
    const data = this.xhr.responseText;
    if (data !== null) {
      this.emitReserved("data", data);
      this.emitReserved("success");
      this.cleanup();
    }
  }

  /**
   * Aborts the request.
   *
   * @package
   */
  public abort() {
    this.cleanup();
  }
}

/**
 * Aborts pending requests when unloading the window. This is needed to prevent
 * memory leaks (e.g. when using IE) and to ensure that no spurious error is
 * emitted.
 */

if (typeof document !== "undefined") {
  // @ts-ignore
  if (typeof attachEvent === "function") {
    // @ts-ignore
    attachEvent("onunload", unloadHandler);
  } else if (typeof addEventListener === "function") {
    const terminationEvent = "onpagehide" in globalThis ? "pagehide" : "unload";
    addEventListener(terminationEvent, unloadHandler, false);
  }
}

function unloadHandler() {
  for (let i in Request.requests) {
    if (Request.requests.hasOwnProperty(i)) {
      Request.requests[i].abort();
    }
  }
}
