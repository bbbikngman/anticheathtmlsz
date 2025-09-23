/**
 * 声网Web端显式订阅管理器
 * 基于声网技术支持的专业建议实现
 */

class WebSubscriptionManager {
  /**
   * 订阅状态枚举
   */
  static SubscriptionState = {
    NOT_SUBSCRIBED: "not_subscribed",
    SUBSCRIBING: "subscribing",
    SUBSCRIBED: "subscribed",
    SUBSCRIPTION_FAILED: "subscription_failed",
    UNSUBSCRIBING: "unsubscribing",
  };

  /**
   * 订阅类型枚举
   */
  static SubscriptionType = {
    AUDIO: "audio",
    VIDEO: "video",
    BOTH: "both",
  };

  constructor(client, options = {}) {
    this.client = client;
    this.options = {
      maxRetryAttempts: options.maxRetryAttempts || 3,
      retryDelay: options.retryDelay || 2000,
      subscriptionTimeout: options.subscriptionTimeout || 10000,
      enableAutoSubscribe: options.enableAutoSubscribe !== false,
      logLevel: options.logLevel || "info",
      ...options,
    };

    // 订阅状态跟踪
    this.subscriptions = new Map(); // uid -> subscription info
    this.subscriptionHistory = [];
    this.retryTimers = new Map(); // uid -> timer

    // 回调函数
    this.onSubscriptionSuccess = null;
    this.onSubscriptionFailed = null;
    this.onSubscriptionStateChanged = null;

    // 绑定事件处理器
    this._bindEventHandlers();

    this._log("info", "显式订阅管理器初始化完成", { options: this.options });
  }

  /**
   * 绑定事件处理器
   */
  _bindEventHandlers() {
    // 用户加入事件 - 声网技术支持建议：显式订阅确保兼容性
    this.client.on("user-joined", this._handleUserJoined.bind(this));
    this.client.on("user-published", this._handleUserPublished.bind(this));
    this.client.on("user-unpublished", this._handleUserUnpublished.bind(this));
    this.client.on("user-left", this._handleUserLeft.bind(this));

    this._log("debug", "事件处理器绑定完成");
  }

  /**
   * 处理用户加入事件
   */
  async _handleUserJoined(user) {
    this._log("info", `用户加入事件: ${user.uid}`, {
      uid: user.uid,
      hasAudio: user.hasAudio,
      hasVideo: user.hasVideo,
    });

    // 记录用户信息
    this._updateSubscriptionInfo(user.uid, {
      state: WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
      user: user,
      joinedAt: new Date(),
      hasAudio: user.hasAudio,
      hasVideo: user.hasVideo,
    });

    // 如果启用自动订阅且用户有媒体流，则尝试订阅
    if (this.options.enableAutoSubscribe) {
      if (user.hasAudio || user.hasVideo) {
        await this._attemptAutoSubscription(user);
      } else {
        this._log("debug", `用户 ${user.uid} 暂无媒体流，等待发布事件`);
      }
    }
  }

  /**
   * 处理用户发布事件
   */
  async _handleUserPublished(user, mediaType) {
    this._log("info", `用户发布事件: ${user.uid}, 媒体类型: ${mediaType}`, {
      uid: user.uid,
      mediaType: mediaType,
      hasAudio: user.hasAudio,
      hasVideo: user.hasVideo,
    });

    // 更新用户媒体状态
    const subscriptionInfo = this.subscriptions.get(user.uid);
    if (subscriptionInfo) {
      subscriptionInfo.hasAudio = user.hasAudio;
      subscriptionInfo.hasVideo = user.hasVideo;
      subscriptionInfo.user = user;
    }

    // 如果启用自动订阅，尝试订阅新发布的媒体
    if (this.options.enableAutoSubscribe) {
      await this.subscribeToUser(user.uid, mediaType);
    }
  }

  /**
   * 处理用户取消发布事件
   */
  _handleUserUnpublished(user, mediaType) {
    this._log("info", `用户取消发布事件: ${user.uid}, 媒体类型: ${mediaType}`, {
      uid: user.uid,
      mediaType: mediaType,
    });

    // 更新订阅状态
    const subscriptionInfo = this.subscriptions.get(user.uid);
    if (subscriptionInfo) {
      if (mediaType === "audio") {
        subscriptionInfo.hasAudio = false;
        subscriptionInfo.audioSubscribed = false;
      } else if (mediaType === "video") {
        subscriptionInfo.hasVideo = false;
        subscriptionInfo.videoSubscribed = false;
      }
    }
  }

  /**
   * 处理用户离开事件
   */
  _handleUserLeft(user) {
    this._log("info", `用户离开事件: ${user.uid}`);

    // 清理订阅信息
    this._cleanupUserSubscription(user.uid);
  }

  /**
   * 尝试自动订阅
   */
  async _attemptAutoSubscription(user) {
    const subscriptionTypes = [];

    if (user.hasAudio) {
      subscriptionTypes.push("audio");
    }
    if (user.hasVideo) {
      subscriptionTypes.push("video");
    }

    if (subscriptionTypes.length > 0) {
      this._log("info", `自动订阅用户 ${user.uid}`, {
        types: subscriptionTypes,
      });

      for (const type of subscriptionTypes) {
        await this.subscribeToUser(user.uid, type);
      }
    }
  }

  /**
   * 订阅用户媒体流
   */
  async subscribeToUser(uid, mediaType = "audio", options = {}) {
    const subscriptionInfo = this.subscriptions.get(uid);
    if (!subscriptionInfo) {
      this._log("error", `用户 ${uid} 不存在，无法订阅`);
      return false;
    }

    const user = subscriptionInfo.user;
    if (!user) {
      this._log("error", `用户 ${uid} 对象不存在，无法订阅`);
      return false;
    }

    // 检查媒体类型可用性
    if (mediaType === "audio" && !user.hasAudio) {
      this._log("warn", `用户 ${uid} 没有音频流，跳过音频订阅`);
      return false;
    }
    if (mediaType === "video" && !user.hasVideo) {
      this._log("warn", `用户 ${uid} 没有视频流，跳过视频订阅`);
      return false;
    }

    // 检查是否已经订阅
    const isAlreadySubscribed = this._isAlreadySubscribed(uid, mediaType);
    if (isAlreadySubscribed) {
      this._log("debug", `用户 ${uid} 的 ${mediaType} 已订阅，跳过`);
      return true;
    }

    return await this._subscribeWithRetry(uid, user, mediaType, options);
  }

  /**
   * 带重试的订阅
   */
  async _subscribeWithRetry(uid, user, mediaType, options = {}) {
    const maxAttempts =
      options.maxRetryAttempts || this.options.maxRetryAttempts;
    const retryDelay = options.retryDelay || this.options.retryDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this._log(
          "info",
          `订阅用户 ${uid} 的 ${mediaType} - 尝试 ${attempt}/${maxAttempts}`
        );

        // 更新订阅状态
        this._updateSubscriptionState(
          uid,
          mediaType,
          WebSubscriptionManager.SubscriptionState.SUBSCRIBING
        );

        // 执行订阅
        const result = await this._performSubscription(user, mediaType);

        if (result) {
          // 订阅成功
          this._updateSubscriptionState(
            uid,
            mediaType,
            WebSubscriptionManager.SubscriptionState.SUBSCRIBED
          );
          this._recordSubscriptionAttempt(uid, mediaType, true, attempt);

          this._log("info", `✅ 用户 ${uid} 的 ${mediaType} 订阅成功`);

          // 调用成功回调
          if (this.onSubscriptionSuccess) {
            try {
              this.onSubscriptionSuccess(uid, mediaType, result);
            } catch (error) {
              this._log("error", "订阅成功回调执行失败", {
                error: error.message,
              });
            }
          }

          return true;
        }
      } catch (error) {
        const errorMessage = `订阅失败 (尝试 ${attempt}/${maxAttempts}): ${error.message}`;
        this._log("error", `❌ 用户 ${uid} 的 ${mediaType} ${errorMessage}`);

        // 记录失败尝试
        this._recordSubscriptionAttempt(
          uid,
          mediaType,
          false,
          attempt,
          error.message
        );

        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxAttempts) {
          const waitTime = retryDelay * attempt; // 递增等待时间
          this._log("info", `⏳ ${waitTime}ms 后重试订阅...`);
          await this._sleep(waitTime);
        } else {
          // 最终失败
          this._updateSubscriptionState(
            uid,
            mediaType,
            WebSubscriptionManager.SubscriptionState.SUBSCRIPTION_FAILED
          );

          // 调用失败回调
          if (this.onSubscriptionFailed) {
            try {
              this.onSubscriptionFailed(uid, mediaType, error);
            } catch (callbackError) {
              this._log("error", "订阅失败回调执行失败", {
                error: callbackError.message,
              });
            }
          }
        }
      }
    }

    this._log(
      "error",
      `❌ 用户 ${uid} 的 ${mediaType} 订阅最终失败，已达到最大重试次数`
    );
    return false;
  }

  /**
   * 执行实际的订阅操作
   */
  async _performSubscription(user, mediaType) {
    const timeout = this.options.subscriptionTimeout;

    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`订阅超时 (${timeout}ms)`));
      }, timeout);

      try {
        let result;

        if (mediaType === "audio") {
          result = await this.client.subscribe(user, "audio");
        } else if (mediaType === "video") {
          result = await this.client.subscribe(user, "video");
        } else {
          throw new Error(`不支持的媒体类型: ${mediaType}`);
        }

        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * 取消订阅用户媒体流
   */
  async unsubscribeFromUser(uid, mediaType = "audio") {
    const subscriptionInfo = this.subscriptions.get(uid);
    if (!subscriptionInfo) {
      this._log("warn", `用户 ${uid} 不存在，无法取消订阅`);
      return false;
    }

    const user = subscriptionInfo.user;
    if (!user) {
      this._log("warn", `用户 ${uid} 对象不存在，无法取消订阅`);
      return false;
    }

    try {
      this._log("info", `取消订阅用户 ${uid} 的 ${mediaType}`);

      // 更新状态
      this._updateSubscriptionState(
        uid,
        mediaType,
        WebSubscriptionManager.SubscriptionState.UNSUBSCRIBING
      );

      // 执行取消订阅
      await this.client.unsubscribe(user, mediaType);

      // 更新状态
      this._updateSubscriptionState(
        uid,
        mediaType,
        WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED
      );

      this._log("info", `✅ 用户 ${uid} 的 ${mediaType} 取消订阅成功`);
      return true;
    } catch (error) {
      this._log("error", `❌ 取消订阅失败: ${error.message}`);
      this._updateSubscriptionState(
        uid,
        mediaType,
        WebSubscriptionManager.SubscriptionState.SUBSCRIPTION_FAILED
      );
      return false;
    }
  }

  /**
   * 检查是否已经订阅
   */
  _isAlreadySubscribed(uid, mediaType) {
    const subscriptionInfo = this.subscriptions.get(uid);
    if (!subscriptionInfo) return false;

    if (mediaType === "audio") {
      return subscriptionInfo.audioSubscribed === true;
    } else if (mediaType === "video") {
      return subscriptionInfo.videoSubscribed === true;
    }

    return false;
  }

  /**
   * 更新订阅信息
   */
  _updateSubscriptionInfo(uid, info) {
    const existing = this.subscriptions.get(uid) || {};
    const updated = { ...existing, ...info, updatedAt: new Date() };
    this.subscriptions.set(uid, updated);
  }

  /**
   * 更新订阅状态
   */
  _updateSubscriptionState(uid, mediaType, state) {
    const subscriptionInfo = this.subscriptions.get(uid);
    if (!subscriptionInfo) return;

    if (mediaType === "audio") {
      subscriptionInfo.audioState = state;
      subscriptionInfo.audioSubscribed =
        state === WebSubscriptionManager.SubscriptionState.SUBSCRIBED;
    } else if (mediaType === "video") {
      subscriptionInfo.videoState = state;
      subscriptionInfo.videoSubscribed =
        state === WebSubscriptionManager.SubscriptionState.SUBSCRIBED;
    }

    subscriptionInfo.updatedAt = new Date();

    // 调用状态变化回调
    if (this.onSubscriptionStateChanged) {
      try {
        this.onSubscriptionStateChanged(uid, mediaType, state);
      } catch (error) {
        this._log("error", "订阅状态变化回调执行失败", {
          error: error.message,
        });
      }
    }
  }

  /**
   * 记录订阅尝试
   */
  _recordSubscriptionAttempt(
    uid,
    mediaType,
    success,
    attempt,
    errorMessage = null
  ) {
    const record = {
      uid,
      mediaType,
      success,
      attempt,
      timestamp: new Date(),
      errorMessage,
    };

    this.subscriptionHistory.push(record);

    // 限制历史记录长度
    if (this.subscriptionHistory.length > 100) {
      this.subscriptionHistory = this.subscriptionHistory.slice(-50);
    }
  }

  /**
   * 清理用户订阅信息
   */
  _cleanupUserSubscription(uid) {
    // 清理重试定时器
    const timer = this.retryTimers.get(uid);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(uid);
    }

    // 移除订阅信息
    this.subscriptions.delete(uid);

    this._log("debug", `用户 ${uid} 的订阅信息已清理`);
  }

  /**
   * 获取订阅统计信息
   */
  getSubscriptionStats() {
    const totalUsers = this.subscriptions.size;
    let audioSubscribed = 0;
    let videoSubscribed = 0;
    let totalAttempts = this.subscriptionHistory.length;
    let successfulAttempts = this.subscriptionHistory.filter(
      (record) => record.success
    ).length;

    for (const [uid, info] of this.subscriptions) {
      if (info.audioSubscribed) audioSubscribed++;
      if (info.videoSubscribed) videoSubscribed++;
    }

    const successRate =
      totalAttempts > 0 ? (successfulAttempts / totalAttempts) * 100 : 0;

    return {
      totalUsers,
      audioSubscribed,
      videoSubscribed,
      totalAttempts,
      successfulAttempts,
      successRate: `${successRate.toFixed(1)}%`,
      autoSubscribeEnabled: this.options.enableAutoSubscribe,
    };
  }

  /**
   * 获取用户订阅信息
   */
  getUserSubscriptionInfo(uid) {
    const info = this.subscriptions.get(uid);
    if (!info) return null;

    return {
      uid,
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
      audioSubscribed: info.audioSubscribed || false,
      videoSubscribed: info.videoSubscribed || false,
      audioState:
        info.audioState ||
        WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
      videoState:
        info.videoState ||
        WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
      joinedAt: info.joinedAt,
      updatedAt: info.updatedAt,
    };
  }

  /**
   * 获取所有用户订阅信息
   */
  getAllSubscriptionInfo() {
    const result = [];
    for (const [uid, info] of this.subscriptions) {
      result.push(this.getUserSubscriptionInfo(uid));
    }
    return result;
  }

  /**
   * 启用/禁用自动订阅
   */
  setAutoSubscribe(enabled) {
    this.options.enableAutoSubscribe = enabled;
    this._log("info", `自动订阅: ${enabled ? "启用" : "禁用"}`);
  }

  /**
   * 睡眠函数
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 日志记录
   */
  _log(level, message, data = null) {
    const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = logLevels[this.options.logLevel] || 1;
    const messageLevel = logLevels[level] || 1;

    if (messageLevel >= currentLevel) {
      const prefix = "[SUBSCRIPTION_MANAGER]";
      const timestamp = new Date().toISOString();

      if (data) {
        console[level](`${prefix} ${timestamp} ${message}`, data);
      } else {
        console[level](`${prefix} ${timestamp} ${message}`);
      }
    }
  }

  /**
   * 销毁订阅管理器
   */
  destroy() {
    // 清理所有定时器
    for (const [uid, timer] of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    // 清理订阅信息
    this.subscriptions.clear();
    this.subscriptionHistory = [];

    // 移除事件监听器
    this.client.off("user-joined", this._handleUserJoined);
    this.client.off("user-published", this._handleUserPublished);
    this.client.off("user-unpublished", this._handleUserUnpublished);
    this.client.off("user-left", this._handleUserLeft);

    this._log("info", "订阅管理器已销毁");
  }
}

// 导出（如果在模块环境中）
if (typeof module !== "undefined" && module.exports) {
  module.exports = WebSubscriptionManager;
}

// 全局暴露（如果在浏览器环境中）
if (typeof window !== "undefined") {
  window.WebSubscriptionManager = WebSubscriptionManager;
}
