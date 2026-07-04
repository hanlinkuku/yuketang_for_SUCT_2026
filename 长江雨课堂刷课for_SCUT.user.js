// ==UserScript==
// @name         长江雨课堂for_SCUT
// @namespace    https://www.shegou.com/
// @version      1.0.10.2
// @description  长江雨课堂for_SCUT
// @author       RHzzz
// @match        https://changjiang.yuketang.cn/v2/web/*
// @match        https://changjiang.yuketang.cn/pro/lms/*
// @icon         https://www.google.com/s2/favicons?domain=yuketang.cn
// @require      https://cdn.staticfile.org/jquery/3.4.1/jquery.min.js
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const LIST_URL_KEY = "cjyt_list_url";
    const RATE = 2;
    const COMPLETE_PROGRESS = 98.5;
    const LOOP_MS = 2000;
    const CLICK_COOLDOWN_MS = 12000;
    const PROGRESS_RE = /([0-9]+(?:\.[0-9]+)?)\s*%/;
    const VIDEO_PROGRESS_RE = /完成度[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/;
    const STUDY_STATUS_RE = /已完成|未开始|进行中|完成度[:：]?\s*[0-9]+(?:\.[0-9]+)?\s*%|[0-9]+(?:\.[0-9]+)?\s*%/;

    let busy = false;
    let navigating = false;
    let currentVideoUrl = "";
    let keepPlayingTimer = null;
    let progressTimer = null;
    let maxVideoProgress = 0;
    let returning = false;
    let lastTargetText = "";
    let lastTargetClickAt = 0;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function clean(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    function getText(el) {
        return clean(el && (el.innerText || el.textContent));
    }

    function showToast(text) {
        let toast = document.getElementById("cjyt-toast");

        if (!toast) {
            toast = document.createElement("div");
            toast.id = "cjyt-toast";
            toast.style.cssText = [
                "position: fixed",
                "right: 20px",
                "top: 20px",
                "z-index: 999999",
                "background: rgba(0,0,0,0.78)",
                "color: #fff",
                "padding: 10px 14px",
                "border-radius: 6px",
                "font-size: 14px",
                "line-height: 1.4",
                "box-shadow: 0 4px 14px rgba(0,0,0,0.18)"
            ].join(";");
            document.body.appendChild(toast);
        }

        toast.textContent = text;
        toast.style.display = "block";

        setTimeout(function () {
            toast.style.display = "none";
        }, 3000);
    }

    function isVisible(el) {
        if (!el) return false;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0";
    }

    function isVideoPage() {
        return location.href.indexOf("/xcloud/video-student/") > -1 ||
            location.href.indexOf("/video") > -1 ||
            !!document.querySelector("video, .xt_video_player");
    }

    function findVideo() {
        return document.querySelector("video") ||
            document.querySelector(".xt_video_player") ||
            null;
    }

    function clickStudyContentTab() {
        const target = Array.from(document.querySelectorAll("[role='tab'], .el-tabs__item, div, span"))
            .filter(isVisible)
            .find(el => getText(el) === "学习内容");

        if (target) {
            target.click();
            console.log("[CJYT] 已切到学习内容");
            return true;
        }

        return false;
    }

    function parseProgress(text) {
        const match = clean(text).match(PROGRESS_RE);
        return match ? Number(match[1]) : null;
    }

    function getVideoProgressFromPage() {
        const nodes = Array.from(document.querySelectorAll("span.text, div, span"))
            .filter(isVisible);

        for (const el of nodes) {
            const match = getText(el).match(VIDEO_PROGRESS_RE);
            if (match) return Number(match[1]);
        }

        return null;
    }

    function hasStudyStatus(text) {
        return STUDY_STATUS_RE.test(text);
    }

    function isProbablyNavText(text) {
        return text === "学习内容" ||
            text === "学习日志" ||
            text === "公告" ||
            text === "成绩单" ||
            text === "错题集" ||
            text.length < 4;
    }

    function getClickableCard(el) {
        let cur = el;

        for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
            const text = getText(cur);
            const rect = cur.getBoundingClientRect();

            if (
                isVisible(cur) &&
                hasStudyStatus(text) &&
                text.length >= 8 &&
                rect.width >= 120 &&
                rect.height >= 24
            ) {
                return cur;
            }

            cur = cur.parentElement;
        }

        return el;
    }

    function getCardUrl(el) {
        const closestLink = el.closest && el.closest("a[href]");
        if (closestLink && closestLink.href) return closestLink.href;

        const childLink = el.querySelector && el.querySelector("a[href]");
        if (childLink && childLink.href) return childLink.href;

        return "";
    }

    function getStudyCards() {
        const statusNodes = Array.from(document.querySelectorAll("div, section, li, article, a, span"))
            .filter(isVisible)
            .map(el => ({ el, text: getText(el) }))
            .filter(item => hasStudyStatus(item.text) && !isProbablyNavText(item.text));

        const cards = statusNodes.map(item => {
            const card = getClickableCard(item.el);
            return {
                el: card,
                text: getText(card),
                url: getCardUrl(card)
            };
        }).filter(item => hasStudyStatus(item.text) && !isProbablyNavText(item.text));

        const unique = [];

        for (const item of cards) {
            if (unique.some(x => x.el === item.el || x.text === item.text)) continue;

            const hasSmallerChild = cards.some(other =>
                other.el !== item.el &&
                item.el.contains(other.el) &&
                other.text.length >= 6 &&
                other.text.length < item.text.length
            );

            if (!hasSmallerChild) unique.push(item);
        }

        return unique;
    }

    function isUnfinishedCard(text) {
        if (text.indexOf("已完成") > -1) return false;
        if (text.indexOf("未开始") > -1) return true;
        if (text.indexOf("进行中") > -1) return true;

        const progress = parseProgress(text);
        return progress !== null && progress < COMPLETE_PROGRESS;
    }

    function clearVideoTimers() {
        if (keepPlayingTimer) {
            clearInterval(keepPlayingTimer);
            keepPlayingTimer = null;
        }

        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }

    function resetVideoState() {
        clearVideoTimers();
        currentVideoUrl = "";
        maxVideoProgress = 0;
    }

    function setSpeed() {
        const speedBox = document.getElementsByClassName("xt_video_player_speed")[0];
        const selector = RATE === 1 || RATE === 2
            ? "[keyt='" + RATE + ".00']"
            : "[keyt='" + RATE + "']";
        const option = document.querySelector(selector);

        if (!speedBox || !option) return;

        const mousemove = document.createEvent("MouseEvent");
        mousemove.initMouseEvent("mousemove", true, true, window, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedBox.dispatchEvent(mousemove);
        option.click();

        console.log("[CJYT] 已设置倍速");
    }

    function playVideo(video) {
        if (!video || returning) return;

        try {
            video.muted = true;
            video.volume = 0;
            video.playbackRate = RATE;

            if (video.paused && !video.ended) {
                video.play();
            }
        } catch (err) {
            console.log("[CJYT] video.play failed:", err);
        }
    }

    function returnToList() {
        if (returning) return;

        returning = true;
        navigating = false;

        const listUrl = sessionStorage.getItem(LIST_URL_KEY);

        console.log("[CJYT] returnToList", {
            current: location.href,
            listUrl
        });

        resetVideoState();

        setTimeout(function () {
            if (listUrl && listUrl !== location.href) {
                location.assign(listUrl);
            } else {
                history.back();
            }
        }, 1500);
    }

    async function startVideoWatcher() {
        navigating = false;

        if (returning) return;

        if (currentVideoUrl === location.href && progressTimer) {
            return;
        }

        clearVideoTimers();
        currentVideoUrl = location.href;
        maxVideoProgress = 0;

        console.log("[CJYT] start video watcher:", location.href);

        let video = null;

        for (let i = 0; i < 40; i++) {
            video = findVideo();
            if (video) break;
            await sleep(500);
        }

        if (!video) {
            console.log("[CJYT] 未找到视频播放器，等待下一轮");
            currentVideoUrl = "";
            return;
        }

        playVideo(video);
        setTimeout(setSpeed, 1000);

        keepPlayingTimer = setInterval(function () {
            playVideo(findVideo());
        }, 1500);

        progressTimer = setInterval(function () {
            const currentVideo = findVideo();

            const pageProgress = getVideoProgressFromPage();
            const videoProgress = currentVideo && currentVideo.duration
                ? currentVideo.currentTime / currentVideo.duration * 100
                : null;

            const progress = Math.max(pageProgress || 0, videoProgress || 0);
            maxVideoProgress = Math.max(maxVideoProgress, progress);

            const restartedAfterAlmostDone =
                maxVideoProgress >= 95 &&
                videoProgress !== null &&
                videoProgress < 5;

            console.log("[CJYT] progress", {
                pageProgress,
                videoProgress,
                progress,
                maxVideoProgress,
                restartedAfterAlmostDone,
                paused: currentVideo ? currentVideo.paused : null,
                ended: currentVideo ? currentVideo.ended : false
            });

            if (
                progress >= COMPLETE_PROGRESS ||
                maxVideoProgress >= COMPLETE_PROGRESS ||
                restartedAfterAlmostDone ||
                (currentVideo && currentVideo.ended)
            ) {
                console.log("[CJYT] 视频完成");
                returnToList();
            }
        }, 3000);
    }

    function clickTargetCard(target) {
        const now = Date.now();
        const sameTarget = lastTargetText === target.text;

        if (sameTarget && now - lastTargetClickAt < CLICK_COOLDOWN_MS) {
            console.log("[CJYT] 等待上次点击跳转完成，跳过重复点击");
            return;
        }

        const beforeUrl = location.href;

        navigating = true;
        lastTargetText = target.text;
        lastTargetClickAt = now;

        console.log("[CJYT] click target:", target.text, {
            targetUrl: target.url
        });

        sessionStorage.setItem(LIST_URL_KEY, location.href);
        target.el.click();

        setTimeout(function () {
            if (isVideoPage()) {
                navigating = false;
                return;
            }

            if (location.href !== beforeUrl) {
                navigating = false;
                return;
            }

            if (target.url) {
                console.log("[CJYT] 点击未跳转，尝试直接访问 targetUrl:", target.url);
                location.assign(target.url);
                return;
            }

            console.log("[CJYT] 点击后仍停留在学习内容页，释放跳转锁");
            navigating = false;
        }, 7000);
    }

    async function handleListPage() {
        returning = false;

        if (navigating) {
            console.log("[CJYT] 正在等待跳转，暂不重复点击");
            return;
        }

        clickStudyContentTab();
        await sleep(1500);

        const cards = getStudyCards();

        console.log("[CJYT] cards:", cards.map((item, index) => ({
            index,
            text: item.text.slice(0, 160),
            url: item.url
        })));

        if (cards.length === 0) {
            console.log("[CJYT] 暂未读到学习内容卡片");
            return;
        }

        const target = cards.find(item => isUnfinishedCard(item.text));

        if (!target) {
            console.log("[CJYT] 所有可见学习内容已完成");
            showToast("已完成！");
            return;
        }

        clickTargetCard(target);
    }

    async function tick() {
        if (busy) return;

        busy = true;

        try {
            if (isVideoPage()) {
                await startVideoWatcher();
            } else {
                resetVideoState();
                await handleListPage();
            }
        } catch (err) {
            console.log("[CJYT] tick error:", err);
            navigating = false;
        } finally {
            busy = false;
        }
    }

    console.log("[CJYT] script loaded:", location.href);

    tick();
    setInterval(tick, LOOP_MS);
})();
