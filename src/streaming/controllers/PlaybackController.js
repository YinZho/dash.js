/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import BufferController from './BufferController';
import URIQueryAndFragmentModel from '../models/URIQueryAndFragmentModel';
import MediaPlayerModel from '../../streaming/models/MediaPlayerModel';
import EventBus from '../../core/EventBus';
import Events from '../../core/events/Events';
import FactoryMaker from '../../core/FactoryMaker';
import Debug from '../../core/Debug';

function PlaybackController() {

    let context = this.context;
    let log = Debug(context).getInstance().log;
    let eventBus = EventBus(context).getInstance();

    let instance,
        streamController,
        timelineConverter,
        metricsModel,
        dashMetrics,
        manifestModel,
        dashManifestModel,
        adapter,
        videoModel,
        currentTime,
        liveStartTime,
        wallclockTimeIntervalId,
        commonEarliestTime,
        streamInfo,
        isDynamic,
        mediaPlayerModel,
        playOnceInitialized;

    function setup() {
        mediaPlayerModel = MediaPlayerModel(context).getInstance();
        reset();
    }

    function initialize(StreamInfo) {
        streamInfo = StreamInfo;
        addAllListeners();
        isDynamic = streamInfo.manifestInfo.isDynamic;
        liveStartTime = streamInfo.start;
        eventBus.on(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        eventBus.on(Events.BYTES_APPENDED, onBytesAppended, this);
        eventBus.on(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
        eventBus.on(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, this);

        if (playOnceInitialized) {
            playOnceInitialized = false;
            play();
        }
    }

    function onPeriodSwitchStarted(e) {
        if (!isDynamic && e.fromStreamInfo && commonEarliestTime[e.fromStreamInfo.id] !== undefined) {
            delete commonEarliestTime[e.fromStreamInfo.id];
        }
    }

    function getTimeToStreamEnd() {
        const startTime = getStreamStartTime(true);
        const offset = isDynamic ? startTime - streamInfo.start : 0;
        return startTime + (streamInfo.duration - offset) - getTime();
    }

    function play() {
        if (videoModel && videoModel.getElement()) {
            videoModel.play();
        } else {
            playOnceInitialized = true;
        }
    }

    function isPaused() {
        return videoModel ? videoModel.isPaused() : null;
    }

    function pause() {
        if (videoModel) {
            videoModel.pause();
        }
    }

    function isSeeking() {
        return videoModel ? videoModel.isSeeking() : null;
    }

    function seek(time) {
        if (videoModel) {
            eventBus.trigger(Events.PLAYBACK_SEEK_ASKED);
            log('Requesting seek to time: ' + time);
            videoModel.setCurrentTime(time);
        }
    }

    function getTime() {
        return videoModel ? videoModel.getTime() : null;
    }

    function getPlaybackRate() {
        return videoModel ? videoModel.getPlaybackRate() : null;
    }

    function getPlayedRanges() {
        return videoModel ? videoModel.getPlayedRanges() : null;
    }

    function getEnded() {
        return videoModel ? videoModel.getEnded() : null;
    }

    function getIsDynamic() {
        return isDynamic;
    }

    function getStreamController() {
        return streamController;
    }

    function setLiveStartTime(value) {
        liveStartTime = value;
    }

    function getLiveStartTime() {
        return liveStartTime;
    }

    /**
     * Computes the desirable delay for the live edge to avoid a risk of getting 404 when playing at the bleeding edge
     * @param {number} fragmentDuration - seconds?
     * @param {number} dvrWindowSize - seconds?
     * @returns {number} object
     * @memberof PlaybackController#
     */
    function computeLiveDelay(fragmentDuration, dvrWindowSize) {
        let mpd = dashManifestModel.getMpd(manifestModel.getValue());

        let delay;
        const END_OF_PLAYLIST_PADDING = 10;

        if (mediaPlayerModel.getUseSuggestedPresentationDelay() && mpd.hasOwnProperty('suggestedPresentationDelay')) {
            delay = mpd.suggestedPresentationDelay;
        } else if (mediaPlayerModel.getLiveDelay()) {
            delay = mediaPlayerModel.getLiveDelay(); // If set by user, this value takes precedence
        } else if (!isNaN(fragmentDuration)) {
            delay = fragmentDuration * mediaPlayerModel.getLiveDelayFragmentCount();
        } else {
            delay = streamInfo.manifestInfo.minBufferTime * 2;
        }

        // cap target latency to:
        // - dvrWindowSize / 2 for short playlists
        // - dvrWindowSize - END_OF_PLAYLIST_PADDING for longer playlists
        let targetDelayCapping = Math.max(dvrWindowSize - END_OF_PLAYLIST_PADDING, dvrWindowSize / 2);

        return Math.min(delay, targetDelayCapping);
    }

    function reset() {
        currentTime = 0;
        liveStartTime = NaN;
        wallclockTimeIntervalId = null;
        playOnceInitialized = false;
        commonEarliestTime = {};
        if (videoModel) {
            eventBus.off(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
            eventBus.off(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
            eventBus.off(Events.BYTES_APPENDED, onBytesAppended, this);
            stopUpdatingWallclockTime();
            removeAllListeners();
        }
        videoModel = null;
        streamInfo = null;
        isDynamic = null;
    }

    function setConfig(config) {
        if (!config) return;

        if (config.streamController) {
            streamController = config.streamController;
        }
        if (config.timelineConverter) {
            timelineConverter = config.timelineConverter;
        }
        if (config.metricsModel) {
            metricsModel = config.metricsModel;
        }
        if (config.dashMetrics) {
            dashMetrics = config.dashMetrics;
        }
        if (config.manifestModel) {
            manifestModel = config.manifestModel;
        }
        if (config.dashManifestModel) {
            dashManifestModel = config.dashManifestModel;
        }
        if (config.adapter) {
            adapter = config.adapter;
        }
        if (config.videoModel) {
            videoModel = config.videoModel;
        }
    }

    /**
     * @param {boolean} ignoreStartOffset - ignore URL fragment start offset if true
     * @returns {number} object
     * @memberof PlaybackController#
     */
    function getStreamStartTime(ignoreStartOffset) {
        let presentationStartTime;
        let fragData = URIQueryAndFragmentModel(context).getInstance().getURIFragmentData();
        let fragS = parseInt(fragData.s, 10);
        let fragT = parseInt(fragData.t, 10);
        let startTimeOffset = NaN;

        if (!ignoreStartOffset) {
            startTimeOffset = !isNaN(fragS) ? fragS : fragT;
        }

        if (isDynamic) {
            if (!isNaN(startTimeOffset) && startTimeOffset > 1262304000) {

                presentationStartTime = startTimeOffset - (streamInfo.manifestInfo.availableFrom.getTime() / 1000);

                if (presentationStartTime > liveStartTime ||
                    presentationStartTime < (liveStartTime - streamInfo.manifestInfo.DVRWindowSize)) {
                    presentationStartTime = null;
                }
            }
            presentationStartTime = presentationStartTime || liveStartTime;

        } else {
            if (!isNaN(startTimeOffset) && startTimeOffset < Math.max(streamInfo.manifestInfo.duration, streamInfo.duration) && startTimeOffset >= 0) {
                presentationStartTime = startTimeOffset;
            } else {
                let earliestTime = commonEarliestTime[streamInfo.id]; //set by ready bufferStart after first onBytesAppended
                if (earliestTime === undefined) {
                    earliestTime = streamController.getActiveStreamCommonEarliestTime(); //deal with calculated PST that is none 0 when streamInfo.start is 0
                }
                presentationStartTime = Math.max(earliestTime, streamInfo.start);
            }
        }

        return presentationStartTime;
    }

    function getActualPresentationTime(currentTime) {
        let metrics = metricsModel.getReadOnlyMetricsFor('video') || metricsModel.getReadOnlyMetricsFor('audio');
        let DVRMetrics = dashMetrics.getCurrentDVRInfo(metrics);
        let DVRWindow = DVRMetrics ? DVRMetrics.range : null;
        let actualTime;

        if (!DVRWindow) return NaN;
        if (currentTime > DVRWindow.end) {
            actualTime = Math.max(DVRWindow.end - streamInfo.manifestInfo.minBufferTime * 2, DVRWindow.start);
        } else if (currentTime < DVRWindow.start) {
            actualTime = DVRWindow.start;
        } else {
            return currentTime;
        }

        return actualTime;
    }

    function startUpdatingWallclockTime() {
        if (wallclockTimeIntervalId !== null) return;

        const tick = function () {
            onWallclockTime();
        };

        wallclockTimeIntervalId = setInterval(tick, mediaPlayerModel.getWallclockTimeUpdateInterval());
    }

    function stopUpdatingWallclockTime() {
        clearInterval(wallclockTimeIntervalId);
        wallclockTimeIntervalId = null;
    }

    function updateCurrentTime() {

        if (isPaused() || !isDynamic || videoModel.getReadyState() === 0) return;
        let currentTime = getTime();
        let actualTime = getActualPresentationTime(currentTime);
        let timeChanged = (!isNaN(actualTime) && actualTime !== currentTime);
        if (timeChanged) {
            seek(actualTime);
        }
    }

    function onDataUpdateCompleted(e) {
        if (e.error) return;

        let representationInfo = adapter.convertDataToTrack(e.currentRepresentation);
        let info = representationInfo.mediaInfo.streamInfo;

        if (streamInfo.id !== info.id) return;
        streamInfo = info;

        updateCurrentTime();
    }

    function onCanPlay() {
        eventBus.trigger(Events.CAN_PLAY);
    }

    function onPlaybackStart() {
        log('Native video element event: play');
        updateCurrentTime();
        startUpdatingWallclockTime();
        eventBus.trigger(Events.PLAYBACK_STARTED, {startTime: getTime()});
    }

    function onPlaybackPlaying() {
        log('Native video element event: playing');
        eventBus.trigger(Events.PLAYBACK_PLAYING, {playingTime: getTime()});
    }

    function onPlaybackPaused() {
        log('Native video element event: pause');
        eventBus.trigger(Events.PLAYBACK_PAUSED, {ended: getEnded()});
    }

    function onPlaybackSeeking() {
        let seekTime = getTime();
        log('Seeking to: ' + seekTime);
        startUpdatingWallclockTime();
        eventBus.trigger(Events.PLAYBACK_SEEKING, {seekTime: seekTime});
    }

    function onPlaybackSeeked() {
        log('Native video element event: seeked');
        eventBus.trigger(Events.PLAYBACK_SEEKED);
    }

    function onPlaybackTimeUpdated() {
        //log("Native video element event: timeupdate");
        let time = getTime();
        if (time === currentTime) return;
        currentTime = time;
        eventBus.trigger(Events.PLAYBACK_TIME_UPDATED, {timeToEnd: getTimeToStreamEnd(), time: time});
    }

    function onPlaybackProgress() {
        //log("Native video element event: progress");
        eventBus.trigger(Events.PLAYBACK_PROGRESS);
    }

    function onPlaybackRateChanged() {
        let rate = getPlaybackRate();
        log('Native video element event: ratechange: ', rate);
        eventBus.trigger(Events.PLAYBACK_RATE_CHANGED, { playbackRate: rate });
    }

    function onPlaybackMetaDataLoaded() {
        log('Native video element event: loadedmetadata');
        eventBus.trigger(Events.PLAYBACK_METADATA_LOADED);
        startUpdatingWallclockTime();
    }

    function onPlaybackEnded() {
        log('Native video element event: ended');
        pause();
        stopUpdatingWallclockTime();
        eventBus.trigger(Events.PLAYBACK_ENDED);
    }

    function onPlaybackError(event) {
        let target = event.target || event.srcElement;
        eventBus.trigger(Events.PLAYBACK_ERROR, {error: target.error});
    }

    function onWallclockTime() {
        eventBus.trigger(Events.WALLCLOCK_TIME_UPDATED, {isDynamic: isDynamic, time: new Date()});
    }

    function onBytesAppended(e) {
        let ranges = e.bufferedRanges;
        if (!ranges || !ranges.length) return;
        if (commonEarliestTime[streamInfo.id] === false) {
            //stream has already been started.
            return;
        }

        let type = e.sender.getType();

        if (commonEarliestTime[streamInfo.id] === undefined) {
            commonEarliestTime[streamInfo.id] = [];
        }

        if (commonEarliestTime[streamInfo.id][type] === undefined) {
            commonEarliestTime[streamInfo.id][type] = Math.max(ranges.start(0), streamInfo.start);
        }

        if (commonEarliestTime[streamInfo.id].audio && commonEarliestTime[streamInfo.id].video) {
            seek(commonEarliestTime[streamInfo.id].audio < commonEarliestTime[streamInfo.id].video ? commonEarliestTime[streamInfo.id].video : commonEarliestTime[streamInfo.id].audio);
            commonEarliestTime[streamInfo.id] = false;
        }
    }

    function onBufferLevelStateChanged(e) {
        // do not stall playback when get an event from Stream that is not active
        if (e.streamInfo.id !== streamInfo.id) return;
        videoModel.setStallState(e.mediaType, e.state === BufferController.BUFFER_EMPTY);
    }

    function addAllListeners() {
        videoModel.addEventListener('canplay', onCanPlay);
        videoModel.addEventListener('play', onPlaybackStart);
        videoModel.addEventListener('playing', onPlaybackPlaying);
        videoModel.addEventListener('pause', onPlaybackPaused);
        videoModel.addEventListener('error', onPlaybackError);
        videoModel.addEventListener('seeking', onPlaybackSeeking);
        videoModel.addEventListener('seeked', onPlaybackSeeked);
        videoModel.addEventListener('timeupdate', onPlaybackTimeUpdated);
        videoModel.addEventListener('progress', onPlaybackProgress);
        videoModel.addEventListener('ratechange', onPlaybackRateChanged);
        videoModel.addEventListener('loadedmetadata', onPlaybackMetaDataLoaded);
        videoModel.addEventListener('ended', onPlaybackEnded);
    }

    function removeAllListeners() {
        videoModel.removeEventListener('canplay', onCanPlay);
        videoModel.removeEventListener('play', onPlaybackStart);
        videoModel.removeEventListener('playing', onPlaybackPlaying);
        videoModel.removeEventListener('pause', onPlaybackPaused);
        videoModel.removeEventListener('error', onPlaybackError);
        videoModel.removeEventListener('seeking', onPlaybackSeeking);
        videoModel.removeEventListener('seeked', onPlaybackSeeked);
        videoModel.removeEventListener('timeupdate', onPlaybackTimeUpdated);
        videoModel.removeEventListener('progress', onPlaybackProgress);
        videoModel.removeEventListener('ratechange', onPlaybackRateChanged);
        videoModel.removeEventListener('loadedmetadata', onPlaybackMetaDataLoaded);
        videoModel.removeEventListener('ended', onPlaybackEnded);
    }

    instance = {
        initialize: initialize,
        setConfig: setConfig,
        getStreamStartTime: getStreamStartTime,
        getTimeToStreamEnd: getTimeToStreamEnd,
        getTime: getTime,
        getPlaybackRate: getPlaybackRate,
        getPlayedRanges: getPlayedRanges,
        getEnded: getEnded,
        getIsDynamic: getIsDynamic,
        getStreamController: getStreamController,
        setLiveStartTime: setLiveStartTime,
        getLiveStartTime: getLiveStartTime,
        computeLiveDelay: computeLiveDelay,
        play: play,
        isPaused: isPaused,
        pause: pause,
        isSeeking: isSeeking,
        seek: seek,
        reset: reset
    };

    setup();

    return instance;
}

PlaybackController.__dashjs_factory_name = 'PlaybackController';
export default FactoryMaker.getSingletonFactory(PlaybackController);
