export default class QrScanner {
    static readonly DEFAULT_CANVAS_SIZE = 400;
    static readonly NO_QR_CODE_FOUND = 'No QR code found';
    static WORKER_PATH = 'qr-scanner-worker.min.js';

    static async hasCamera(): Promise<boolean> {
        try {
            return !!(await QrScanner.listCameras(false)).length;
        } catch (e) {
            return false;
        }
    }

    static async listCameras(requestLabels = false): Promise<Array<QrScanner.Camera>> {
        if (!navigator.mediaDevices) return [];

        const enumerateCameras = async (): Promise<Array<MediaDeviceInfo>> =>
            (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');

        // Note that enumerateDevices can always be called and does not prompt the user for permission.
        // However, enumerateDevices only includes device labels if served via https and an active media stream exists
        // or permission to access the camera was given. Therefore, if we're not getting labels but labels are requested
        // ask for camera permission by opening a stream.
        let openedStream: MediaStream | undefined;
        try {
            if (requestLabels && (await enumerateCameras()).every((camera) => !camera.label)) {
                openedStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            }
        } catch (e) {
            // Fail gracefully, especially if the device has no camera or on mobile when the camera is already in use
            // and some browsers disallow a second stream.
        }

        try {
            return (await enumerateCameras()).map((camera, i) => ({
                id: camera.deviceId,
                label: camera.label || (i === 0 ? 'Default Camera' : `Camera ${i + 1}`),
            }));
        } finally {
            // close the stream we just opened for getting camera access for listing the device labels
            if (openedStream) {
                console.warn('Call listCameras after successfully starting a QR scanner to avoid creating '
                    + 'a temporary video stream');
                QrScanner._stopVideoStream(openedStream);
            }
        }
    }

    $video: HTMLVideoElement;
    $canvas: HTMLCanvasElement;
    private readonly _onDecode: (result: string) => void;
    private _preferredCamera: QrScanner.FacingMode | QrScanner.DeviceId;
    private _scanRegion: QrScanner.ScanRegion;
    private _legacyCanvasSize: number = QrScanner.DEFAULT_CANVAS_SIZE;
    private _qrEnginePromise: Promise<Worker | BarcodeDetector>
    private _active: boolean = false;
    private _paused: boolean = false;
    private _flashOn: boolean = false;
    private _destroyed: boolean = false;

    constructor(
        video: HTMLVideoElement,
        onDecode: (result: string) => void,
        onDecodeError?: (error: Error | string) => void,
        calculateScanRegion?: (video: HTMLVideoElement) => QrScanner.ScanRegion,
        preferredCamera?: QrScanner.FacingMode | QrScanner.DeviceId,
    );
    /** @deprecated */
    constructor(
        video: HTMLVideoElement,
        onDecode: (result: string) => void,
        onDecodeError?: (error: Error | string) => void,
        canvasSize?: number,
        preferredCamera?: QrScanner.FacingMode | QrScanner.DeviceId,
    );
    /** @deprecated */
    constructor(video: HTMLVideoElement, onDecode: (result: string) => void, canvasSize?: number);
    constructor(
        video: HTMLVideoElement,
        onDecode: (result: string) => void,
        canvasSizeOrOnDecodeError?: number | ((error: Error | string) => void),
        canvasSizeOrCalculateScanRegion?: number | ((video: HTMLVideoElement) => QrScanner.ScanRegion),
        preferredCamera: QrScanner.FacingMode | QrScanner.DeviceId = 'environment',
    ) {
        canvasSizeOrOnDecodeError = canvasSizeOrOnDecodeError || this._onDecodeError;
        canvasSizeOrCalculateScanRegion = canvasSizeOrCalculateScanRegion || this._calculateScanRegion;

        this.$video = video;
        this.$canvas = document.createElement('canvas');
        this._onDecode = onDecode;
        this._preferredCamera = preferredCamera;

        if (typeof canvasSizeOrOnDecodeError === 'number') {
            // legacy function signature where the third argument is the canvas size
            this._legacyCanvasSize = canvasSizeOrOnDecodeError;
            console.warn('You\'re using a deprecated version of the QrScanner constructor which will be removed in '
                + 'the future');
        } else {
            this._onDecodeError = canvasSizeOrOnDecodeError;
        }

        if (typeof canvasSizeOrCalculateScanRegion === 'number') {
            // legacy function signature where the fourth argument is the canvas size
            this._legacyCanvasSize = canvasSizeOrCalculateScanRegion;
            console.warn('You\'re using a deprecated version of the QrScanner constructor which will be removed in '
                + 'the future');
        } else {
            this._calculateScanRegion = canvasSizeOrCalculateScanRegion;
        }

        this._scanRegion = this._calculateScanRegion(video);

        this._onPlay = this._onPlay.bind(this);
        this._onLoadedMetaData = this._onLoadedMetaData.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);

        // @ts-ignore
        video.disablePictureInPicture = true;
        // Allow inline playback on iPhone instead of requiring full screen playback,
        // see https://webkit.org/blog/6784/new-video-policies-for-ios/
        // @ts-ignore
        video.playsInline = true;
        // Allow play() on iPhone without requiring a user gesture. Should not really be needed as camera stream
        // includes no audio, but just to be safe.
        video.muted = true;

        // Avoid Safari stopping the video stream on a hidden video.
        // See https://github.com/cozmo/jsQR/issues/185
        let shouldHideVideo = false;
        if (video.hidden) {
            video.hidden = false;
            shouldHideVideo = true;
        }
        if (!document.body.contains(video)) {
            document.body.appendChild(video);
            shouldHideVideo = true;
        }
        requestAnimationFrame(() => {
            // Checking in requestAnimationFrame which should avoid a potential additional re-flow for getComputedStyle.
            const computedStyle = window.getComputedStyle(video);
            if (computedStyle.display === 'none') {
                video.style.setProperty('display', 'block', 'important');
                shouldHideVideo = true;
            }
            if (computedStyle.visibility !== 'visible') {
                video.style.setProperty('visibility', 'visible', 'important');
                shouldHideVideo = true;
            }
            if (shouldHideVideo) {
                // Hide the video in a way that doesn't cause Safari to stop the playback.
                console.warn('QrScanner has overwritten the video hiding style to avoid Safari stopping the playback.');
                video.style.opacity = '0';
                video.style.width = '0';
                video.style.height = '0';
            }
        });

        video.addEventListener('play', this._onPlay);
        video.addEventListener('loadedmetadata', this._onLoadedMetaData);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        this._qrEnginePromise = QrScanner.createQrEngine();
    }

    async hasFlash(): Promise<boolean> {
        let stream: MediaStream | undefined;
        try {
            if (this.$video.srcObject) {
                if (!(this.$video.srcObject instanceof MediaStream)) return false; // srcObject is not a camera stream
                stream = this.$video.srcObject;
            } else {
                stream = (await this._getCameraStream()).stream;
            }
            return 'torch' in stream.getVideoTracks()[0].getSettings();
        } catch (e) {
            return false;
        } finally {
            // close the stream we just opened for detecting whether it supports flash
            if (stream && stream !== this.$video.srcObject) {
                console.warn('Call hasFlash after successfully starting the scanner to avoid creating '
                    + 'a temporary video stream');
                QrScanner._stopVideoStream(stream);
            }
        }
    }

    isFlashOn(): boolean {
        return this._flashOn;
    }

    async toggleFlash(): Promise<void> {
        if (this._flashOn) {
            await this.turnFlashOff();
        } else {
            await this.turnFlashOn();
        }
    }

    async turnFlashOn(): Promise<void> {
        if (this._flashOn || this._destroyed) return;
        this._flashOn = true;
        if (!this._active || this._paused) return; // flash will be turned on later on .start()
        try {
            if (!await this.hasFlash()) throw 'No flash available';
            // Note that the video track is guaranteed to exist and to be a MediaStream due to the check in hasFlash
            await (this.$video.srcObject as MediaStream).getVideoTracks()[0].applyConstraints({
                // @ts-ignore: constraint 'torch' is unknown to ts
                advanced: [{ torch: true }],
            });
        } catch (e) {
            this._flashOn = false;
            throw e;
        }
    }

    async turnFlashOff(): Promise<void> {
        if (!this._flashOn) return;
        // applyConstraints with torch: false does not work to turn the flashlight off, as a stream's torch stays
        // continuously on, see https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints#torch. Therefore,
        // we have to stop the stream to turn the flashlight off.
        this._flashOn = false;
        await this._restartVideoStream();
    }

    destroy(): void {
        this.$video.removeEventListener('loadedmetadata', this._onLoadedMetaData);
        this.$video.removeEventListener('play', this._onPlay);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);

        this._destroyed = true;
        this._flashOn = false;
        this.stop(); // sets this._paused = true and this._active = false
        QrScanner._postWorkerMessage(this._qrEnginePromise, 'close');
    }

    async start(): Promise<void> {
        if ((this._active && !this._paused) || this._destroyed) return;

        if (window.location.protocol !== 'https:') {
            // warn but try starting the camera anyways
            console.warn('The camera stream is only accessible if the page is transferred via https.');
        }

        this._active = true;
        if (document.hidden) return; // camera will be started as soon as tab is in foreground
        this._paused = false;
        if (this.$video.srcObject) {
            // camera stream already/still set
            await this.$video.play();
            return;
        }

        try {
            const { stream, facingMode } = await this._getCameraStream();
            if (!this._active || this._paused) {
                // was stopped in the meantime
                QrScanner._stopVideoStream(stream);
                return;
            }
            this.$video.srcObject = stream;
            await this.$video.play();
            this._setVideoMirror(facingMode);

            // Restart the flash if it was previously on
            if (this._flashOn) {
                this._flashOn = false; // force turnFlashOn to restart the flash
                this.turnFlashOn().catch(() => {});
            }
        } catch (e) {
            if (this._paused) return;
            this._active = false;
            throw e;
        }
    }

    stop(): void {
        this.pause();
        this._active = false;
    }

    async pause(stopStreamImmediately = false): Promise<boolean> {
        this._paused = true;
        if (!this._active) return true;
        this.$video.pause();

        const stopStream = () => {
            if (this.$video.srcObject instanceof MediaStream) {
                // revoke srcObject only if it's a stream which was likely set by us
                QrScanner._stopVideoStream(this.$video.srcObject);
                this.$video.srcObject = null;
            }
        };

        if (stopStreamImmediately) {
            stopStream();
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!this._paused) return false;
        stopStream();
        return true;
    }

    async setCamera(facingModeOrDeviceId: QrScanner.FacingMode | QrScanner.DeviceId): Promise<void> {
        if (facingModeOrDeviceId === this._preferredCamera) return;
        this._preferredCamera = facingModeOrDeviceId;
        // Restart the scanner with the new camera which will also update the video mirror and the scan region.
        await this._restartVideoStream();
    }

    static async scanImage(
        imageOrFileOrBlobOrUrl: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
            | SVGImageElement | File | Blob | URL | String,
        scanRegion?: QrScanner.ScanRegion | null,
        qrEngine?: Worker | BarcodeDetector | Promise<Worker | BarcodeDetector> | null,
        canvas?: HTMLCanvasElement | null,
        disallowCanvasResizing: boolean = false,
        alsoTryWithoutScanRegion: boolean = false,
    ): Promise<string> {
        const gotExternalEngine = !!qrEngine;

        try {
            let image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
                | SVGImageElement;
            let canvasContext: CanvasRenderingContext2D;
            [qrEngine, image] = await Promise.all([
                qrEngine || QrScanner.createQrEngine(),
                QrScanner._loadImage(imageOrFileOrBlobOrUrl),
            ]);
            [canvas, canvasContext] = QrScanner._drawToCanvas(image, scanRegion, canvas, disallowCanvasResizing);

            if (qrEngine instanceof Worker) {
                const qrEngineWorker = qrEngine; // for ts to know that it's still a worker later in the event listeners
                if (!gotExternalEngine) {
                    // Enable scanning of inverted color qr codes. Not using _postWorkerMessage as it's async
                    qrEngineWorker.postMessage({ type: 'inversionMode', data: 'both' });
                }
                return await new Promise((resolve, reject) => {
                    let timeout: number;
                    let onMessage: (event: MessageEvent) => void;
                    let onError: (error: ErrorEvent | string) => void;
                    onMessage = (event: MessageEvent) => {
                        if (event.data.type !== 'qrResult') {
                            return;
                        }
                        qrEngineWorker.removeEventListener('message', onMessage);
                        qrEngineWorker.removeEventListener('error', onError);
                        clearTimeout(timeout);
                        if (event.data.data !== null) {
                            resolve(event.data.data);
                        } else {
                            reject(QrScanner.NO_QR_CODE_FOUND);
                        }
                    };
                    onError = (error: ErrorEvent | string) => {
                        qrEngineWorker.removeEventListener('message', onMessage);
                        qrEngineWorker.removeEventListener('error', onError);
                        clearTimeout(timeout);
                        const errorMessage = !error ? 'Unknown Error' : ((error as ErrorEvent).message || error);
                        reject('Scanner error: ' + errorMessage);
                    };
                    qrEngineWorker.addEventListener('message', onMessage);
                    qrEngineWorker.addEventListener('error', onError);
                    timeout = setTimeout(() => onError('timeout'), 10000);
                    const imageData = canvasContext.getImageData(0, 0, canvas!.width, canvas!.height);
                    qrEngineWorker.postMessage({
                        type: 'decode',
                        data: imageData
                    }, [imageData.data.buffer]);
                });
            } else {
                return await Promise.race([
                    new Promise<string>((resolve, reject) => window.setTimeout(
                        () => reject('Scanner error: timeout'),
                        10000,
                    )),
                    (async (): Promise<string> => {
                        try {
                            const [scanResult] = await qrEngine.detect(canvas!);
                            if (!scanResult) throw QrScanner.NO_QR_CODE_FOUND;
                            return scanResult.rawValue;
                        } catch (e) {
                            throw `Scanner error: ${(e as Error).message || e}`;
                        }
                    })(),
                ]);
            }
        } catch (e) {
            if (!scanRegion || !alsoTryWithoutScanRegion) throw e;
            return await QrScanner.scanImage(imageOrFileOrBlobOrUrl, null, qrEngine, canvas, disallowCanvasResizing);
        } finally {
            if (!gotExternalEngine) {
                QrScanner._postWorkerMessage(qrEngine!, 'close');
            }
        }
    }

    setGrayscaleWeights(red: number, green: number, blue: number, useIntegerApproximation: boolean = true): void {
        // Note that for the native BarcodeDecoder or if the worker was destroyed, this is a no-op. However, the native
        // implementations work also well with colored qr codes.
        QrScanner._postWorkerMessage(
            this._qrEnginePromise,
            'grayscaleWeights',
            { red, green, blue, useIntegerApproximation }
        );
    }

    setInversionMode(inversionMode: QrScanner.InversionMode): void {
        // Note that for the native BarcodeDecoder or if the worker was destroyed, this is a no-op. However, the native
        // implementations scan normal and inverted qr codes by default
        QrScanner._postWorkerMessage(this._qrEnginePromise, 'inversionMode', inversionMode);
    }

    static async createQrEngine(workerPath: string = QrScanner.WORKER_PATH): Promise<Worker | BarcodeDetector> {
        const hasNativeBarcodeDetector = 'BarcodeDetector' in window && BarcodeDetector.getSupportedFormats
            ? (await BarcodeDetector.getSupportedFormats()).includes('qr_code')
            : false;
        return hasNativeBarcodeDetector ? new BarcodeDetector({ formats: ['qr_code'] }) : new Worker(workerPath);
    }

    private _onPlay(): void {
        this._scanRegion = this._calculateScanRegion(this.$video);
        this._scanFrame();
    }

    private _onLoadedMetaData(): void {
        this._scanRegion = this._calculateScanRegion(this.$video);
    }

    private _onVisibilityChange(): void {
        if (document.hidden) {
            this.pause();
        } else if (this._active) {
            this.start();
        }
    }

    private _calculateScanRegion(video: HTMLVideoElement): QrScanner.ScanRegion {
        // Default scan region calculation. Note that this can be overwritten in the constructor.
        const smallestDimension = Math.min(video.videoWidth, video.videoHeight);
        const scanRegionSize = Math.round(2 / 3 * smallestDimension);
        return {
            x: Math.round((video.videoWidth - scanRegionSize) / 2),
            y: Math.round((video.videoHeight - scanRegionSize) / 2),
            width: scanRegionSize,
            height: scanRegionSize,
            downScaledWidth: this._legacyCanvasSize,
            downScaledHeight: this._legacyCanvasSize,
        };
    }

    private _scanFrame(): void {
        if (!this._active || this.$video.paused || this.$video.ended) return;
        // using requestAnimationFrame to avoid scanning if tab is in background
        requestAnimationFrame(async () => {
            if (this.$video.readyState <= 1) {
                // Skip scans until the video is ready as drawImage() only works correctly on a video with readyState
                // > 1, see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage#Notes.
                // This also avoids false positives for videos paused after a successful scan which remains visible on
                // the canvas until the video is started again and ready.
                this._scanFrame();
                return;
            }

            let result: string | undefined;
            try {
                result = await QrScanner.scanImage(
                    this.$video,
                    this._scanRegion,
                    this._qrEnginePromise,
                    this.$canvas,
                );
            } catch (error) {
                if (!this._active) return;
                const errorMessage = (error as Error).message || error as string;
                if (errorMessage.includes('service unavailable')) {
                    // When the native BarcodeDetector crashed, create a new one
                    this._qrEnginePromise = QrScanner.createQrEngine();
                }
                this._onDecodeError(error as Error | string);
            }

            if (result) {
                this._onDecode(result);
            }

            this._scanFrame();
        });
    }

    private _onDecodeError(error: Error | string): void {
        // default error handler; can be overwritten in the constructor
        if (error === QrScanner.NO_QR_CODE_FOUND) return;
        console.log(error);
    }

    private async _getCameraStream(): Promise<{ stream: MediaStream, facingMode: QrScanner.FacingMode }> {
        if (!navigator.mediaDevices) throw 'Camera not found.';

        const preferenceType = /^(environment|user)$/.test(this._preferredCamera)
            ? 'facingMode'
            : 'deviceId';
        const constraintsWithoutCamera: Array<MediaTrackConstraints> = [{
            width: { min: 1024 }
        }, {
            width: { min: 768 }
        }, {}];
        const constraintsWithCamera = constraintsWithoutCamera.map((constraint) => Object.assign({}, constraint, {
            [preferenceType]: { exact: this._preferredCamera },
        }));

        for (const constraints of [...constraintsWithCamera, ...constraintsWithoutCamera]) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
                // Try to determine the facing mode from the stream, otherwise use a guess or 'environment' as
                // default. Note that the guess is not always accurate as Safari returns cameras of different facing
                // mode, even for exact facingMode constraints.
                const facingMode = this._getFacingMode(stream)
                    || (constraints.facingMode
                        ? this._preferredCamera as QrScanner.FacingMode // a facing mode we were able to fulfill
                        : (this._preferredCamera === 'environment'
                            ? 'user' // switch as _preferredCamera was environment but we are not able to fulfill it
                            : 'environment' // switch from unfulfilled user facingMode or default to environment
                        )
                    );
                return { stream, facingMode };
            } catch (e) {}
        }

        throw 'Camera not found.';
    }

    private async _restartVideoStream(): Promise<void> {
        // Note that we always pause the stream and not only if !this._paused as even if this._paused === true, the
        // stream might still be running, as it's by default only stopped after a delay of 300ms.
        const wasPaused = this._paused;
        const paused = await this.pause(true);
        if (!paused || wasPaused || !this._active) return;
        await this.start();
    }

    private static _stopVideoStream(stream : MediaStream): void {
        for (const track of stream.getTracks()) {
            track.stop(); //  note that this will also automatically turn the flashlight off
            stream.removeTrack(track);
        }
    }

    private _setVideoMirror(facingMode: QrScanner.FacingMode): void {
        // in user facing mode mirror the video to make it easier for the user to position the QR code
        const scaleFactor = facingMode === 'user'? -1 : 1;
        this.$video.style.transform = 'scaleX(' + scaleFactor + ')';
    }

    private _getFacingMode(videoStream: MediaStream): QrScanner.FacingMode | null {
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) return null; // unknown
        // inspired by https://github.com/JodusNodus/react-qr-reader/blob/master/src/getDeviceId.js#L13
        return /rear|back|environment/i.test(videoTrack.label)
            ? 'environment'
            : /front|user|face/i.test(videoTrack.label)
                ? 'user'
                : null; // unknown
    }

    private static _drawToCanvas(
        image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
            | SVGImageElement,
        scanRegion?: QrScanner.ScanRegion | null,
        canvas?: HTMLCanvasElement | null,
        disallowCanvasResizing= false,
    ): [HTMLCanvasElement, CanvasRenderingContext2D] {
        canvas = canvas || document.createElement('canvas');
        const scanRegionX = scanRegion && scanRegion.x ? scanRegion.x : 0;
        const scanRegionY = scanRegion && scanRegion.y ? scanRegion.y : 0;
        const scanRegionWidth = scanRegion && scanRegion.width
            ? scanRegion.width
            : (image as HTMLVideoElement).videoWidth || image.width as number;
        const scanRegionHeight = scanRegion && scanRegion.height
            ? scanRegion.height
            : (image as HTMLVideoElement).videoHeight || image.height as number;

        if (!disallowCanvasResizing) {
            const canvasWidth = scanRegion && scanRegion.downScaledWidth
                ? scanRegion.downScaledWidth
                : scanRegionWidth;
            const canvasHeight = scanRegion && scanRegion.downScaledHeight
                ? scanRegion.downScaledHeight
                : scanRegionHeight;
            // Setting the canvas width or height clears the canvas, even if the values didn't change, therefore only
            // set them if they actually changed.
            if (canvas.width !== canvasWidth) {
                canvas.width = canvasWidth;
            }
            if (canvas.height !== canvasHeight) {
                canvas.height = canvasHeight;
            }
        }

        const context = canvas.getContext('2d', { alpha: false })!;
        context.imageSmoothingEnabled = false; // gives less blurry images
        context.drawImage(
            image,
            scanRegionX, scanRegionY, scanRegionWidth, scanRegionHeight,
            0, 0, canvas.width, canvas.height,
        );
        return [canvas, context];
    }

    private static async _loadImage(
        imageOrFileOrBlobOrUrl: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
            | SVGImageElement | File | Blob | URL | String,
    ): Promise<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap
        | SVGImageElement > {
        if (imageOrFileOrBlobOrUrl instanceof Image) {
            await QrScanner._awaitImageLoad(imageOrFileOrBlobOrUrl);
            return imageOrFileOrBlobOrUrl;
        } else if (imageOrFileOrBlobOrUrl instanceof HTMLVideoElement
            || imageOrFileOrBlobOrUrl instanceof HTMLCanvasElement
            || imageOrFileOrBlobOrUrl instanceof SVGImageElement
            || 'OffscreenCanvas' in window && imageOrFileOrBlobOrUrl instanceof OffscreenCanvas
            || 'ImageBitmap' in window && imageOrFileOrBlobOrUrl instanceof ImageBitmap) {
            return imageOrFileOrBlobOrUrl;
        } else if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob
            || imageOrFileOrBlobOrUrl instanceof URL || typeof imageOrFileOrBlobOrUrl === 'string') {
            const image = new Image();
            if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                image.src = URL.createObjectURL(imageOrFileOrBlobOrUrl);
            } else {
                image.src = imageOrFileOrBlobOrUrl.toString();
            }
            try {
                await QrScanner._awaitImageLoad(image);
                return image;
            } finally {
                if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                    URL.revokeObjectURL(image.src);
                }
            }
        } else {
            throw 'Unsupported image type.';
        }
    }

    private static async _awaitImageLoad(image: HTMLImageElement): Promise<void> {
        if (image.complete && image.naturalWidth !== 0) return; // already loaded
        await new Promise<void>((resolve, reject) => {
            const listener = (event: ErrorEvent | Event) => {
                image.removeEventListener('load', listener);
                image.removeEventListener('error', listener);
                if (event instanceof ErrorEvent) {
                    reject('Image load error');
                } else {
                    resolve();
                }
            };
            image.addEventListener('load', listener);
            image.addEventListener('error', listener);
        });
    }

    private static async _postWorkerMessage(
        qrEngineOrQrEnginePromise: Worker | BarcodeDetector | Promise<Worker | BarcodeDetector>,
        type: string,
        data?: any,
    ): Promise<void> {
        const qrEngine = await qrEngineOrQrEnginePromise;
        if (!(qrEngine instanceof Worker)) return;
        qrEngine.postMessage({ type, data });
    }
}

declare namespace QrScanner {
    export interface ScanRegion {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        downScaledWidth?: number;
        downScaledHeight?: number;
    }

    export type FacingMode = 'environment' | 'user';
    export type DeviceId = string;

    export interface Camera {
        id: DeviceId;
        label: string;
    }

    export type InversionMode = 'original' | 'invert' | 'both';
}

// simplified from https://wicg.github.io/shape-detection-api/#barcode-detection-api
declare class BarcodeDetector {
    constructor(options?: { formats: string[] });
    static getSupportedFormats(): Promise<string[]>;
    detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}
