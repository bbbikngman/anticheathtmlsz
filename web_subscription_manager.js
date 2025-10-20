/**
 * 声网Web端显式订阅管理器
 * 基于声网技术支持的专业建议实现
 */

/**
 * UID 处理辅助函数
 * 解决后端返回的 UID 可能是字符串或数字，而 Agora SDK 中的 UID 类型不一致的问题
 */
function normalizeUID(uid) {
  return String(uid);
}

/**
 * 在远端用户列表中查找指定 UID 的用户
 * 使用字符串化比较避免类型不匹配问题
 */
function findRemoteUser(client, targetUid) {
  const normalizedTarget = normalizeUID(targetUid);
  return client.remoteUsers.find(u => normalizeUID(u.uid) === normalizedTarget);
}

/**
 * 比较两个 UID 是否相等
 * 使用字符串化比较避免类型不匹配问题
 */
function isUIDEqual(uid1, uid2) {
  return normalizeUID(uid1) === normalizeUID(uid2);
}

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
    this._boundHandlers = {
      userJoined: this._handleUserJoined.bind(this),
      userPublished: this._handleUserPublished.bind(this),
      userUnpublished: this._handleUserUnpublished.bind(this),
      userLeft: this._handleUserLeft.bind(this),
    };

    // 绑定：
    this.client.on("user-joined", this._boundHandlers.userJoined);
    this.client.on("user-published", this._boundHandlers.userPublished);
    this.client.on("user-unpublished", this._boundHandlers.userUnpublished);
    this.client.on("user-left", this._boundHandlers.userLeft);

    // 订阅状态跟踪
    this.subscriptions = new Map(); // uid -> subscription info
    this.subscriptionHistory = [];
    this.retryTimers = new Map(); // uid -> timer

    // 回调函数
    this.onSubscriptionSuccess = null;
    this.onSubscriptionFailed = null;
    this.onSubscriptionStateChanged = null;

    

    this._log("info", "显式订阅管理器初始化完成", { options: this.options });
    
    // 补种：把 join 之前已经在频道里的远端用户收录进来
    this._seedExistingRemoteUsers();
  }

  /**
   * 补种已存在的远端用户
   * 解决在 join 后创建订阅管理器时错过已在频道用户的问题
   */
  _seedExistingRemoteUsers() {
    const users = this.client.remoteUsers || [];
    this._log("info", `开始补种已存在的远端用户，共 ${users.length} 个用户`);
    
    for (const u of users) {
      const uid = normalizeUID(u.uid);
      if (!this.subscriptions.has(uid)) {
        this._updateSubscriptionInfo(u.uid, {
          user: u,
          hasAudio: u.hasAudio,
          hasVideo: u.hasVideo,
          state: WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
          joinedAt: new Date(),
        });
        this._log("debug", `补种远端用户 ${u.uid}（hasAudio=${u.hasAudio}, hasVideo=${u.hasVideo}）`);
      } else {
        this._log("debug", `用户 ${u.uid} 已存在于订阅记录中，跳过补种`);
      }
    }
    
    this._log("info", `补种完成，当前订阅记录中共有 ${this.subscriptions.size} 个用户`);
  }

  /**
   * 绑定事件处理器
   */
 
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

  // === [扩展1] 兜底扫描（只针对 Bot 用户） ===
  if (user.hasAudio && window.WebUIDValidator?.isBotUser(user.uid)) {
    try {
      const success = await this.subscribeToUser(user.uid, "audio");
      if (success && user.audioTrack) {
        user.audioTrack.play("remoteAudio");
        this._log("info", `🔄 兜底订阅 Bot 用户 ${user.uid} 成功`);
      }
    } catch (err) {
      this._log("error", `兜底订阅 Bot 用户失败: ${err.message}`);
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
    const normalizedUID = normalizeUID(user.uid);
    const subscriptionInfo = this.subscriptions.get(normalizedUID);
    if (subscriptionInfo) {
      subscriptionInfo.hasAudio = user.hasAudio;
      subscriptionInfo.hasVideo = user.hasVideo;
      subscriptionInfo.user = user;
    } else {
      // 如果 _handleUserJoined 没有及时更新，这里也尝试更新
      this._updateSubscriptionInfo(user.uid, {
        user: user,
        hasAudio: user.hasAudio,
        hasVideo: user.hasVideo,
        state: WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
        joinedAt: subscriptionInfo?.joinedAt || new Date(), // 尽可能保留加入时间
        updatedAt: new Date(),
      });
    }

    // 如果启用自动订阅，只订阅音频流，避免视频订阅
    if (this.options.enableAutoSubscribe && mediaType === "audio") {
      await this.subscribeToUser(user.uid, mediaType);
    }

    // === [增强] 针对 Bot 用户的订阅状态检查和重试机制 ===
    if (mediaType === "audio" && window.WebUIDValidator?.isBotUser(user.uid)) {
      // 检查当前状态：如果订阅失败或 user.hasAudio 为 false
      const isSubscribed = this._isAlreadySubscribed(user.uid, mediaType);
      const hasAudioTrack = user.hasAudio;

      if (!isSubscribed && !hasAudioTrack) {
        this._log("warn", `Bot用户 ${user.uid} 发布音频，但 Agora SDK 状态显示 hasAudio 为 false，启动重试机制...`);
        // 立即尝试一次订阅，以防万一
        // await this.subscribeToUser(user.uid, mediaType); // 可选：先尝试一次
        this._scheduleBotSubscriptionRetry(user.uid, mediaType);
      } else if (!isSubscribed && hasAudioTrack) {
        // 如果 hasAudio 为 true，但尚未订阅，则尝试订阅
        this._log("info", `Bot用户 ${user.uid} hasAudio 为 true，但尚未订阅，尝试订阅...`);
        try {
          await this.subscribeToUser(user.uid, mediaType);
        } catch (error) {
          this._log("warn", `Bot用户 ${user.uid} 初始订阅失败，启动重试机制...`, error);
          this._scheduleBotSubscriptionRetry(user.uid, mediaType);
        }
      }
      // 如果已经订阅，则不需要重试
    }
  }

 /**
   * 新增：为 Bot 用户安排订阅重试
   * @param {string|number} uid - Bot 用户的 UID
   * @param {string} mediaType - 媒体类型，通常是 "audio"
   */
  _scheduleBotSubscriptionRetry(uid, mediaType) {
    // 清除可能存在的旧重试任务
    this._clearBotSubscriptionRetry(uid);

    const maxAttempts = this.options.maxRetryAttempts || 5; // 增加重试次数
    const retryDelay = this.options.retryDelay || 1000; // 重试间隔 1 秒

    let attempts = 0;

    const retry = async () => {
      attempts++;
      this._log("info", `重试订阅Bot用户 ${uid} 的 ${mediaType} (尝试 ${attempts}/${maxAttempts})`);

      // 从 Agora 客户端重新获取用户信息
      const agoraUser = findRemoteUser(this.client, uid);
      if (agoraUser) {
        const hasAudioTrack = agoraUser.hasAudio;
        const isSubscribed = this._isAlreadySubscribed(uid, mediaType);

        this._log("debug", `Bot用户 ${uid} Agora SDK 状态: hasAudio=${hasAudioTrack}, 本地订阅状态=${isSubscribed}`);

        if (hasAudioTrack && !isSubscribed) {
          this._log("info", `Bot用户 ${uid} Agora SDK 显示音频轨道可用，尝试订阅...`);
          try {
            const success = await this.subscribeToUser(uid, mediaType);
            if (success) {
              this._log("info", `✅ Bot用户 ${uid} 的 ${mediaType} 重试订阅成功！`);
              // 订阅成功后，清除重试任务
              this._clearBotSubscriptionRetry(uid);
              return; // 成功后退出
            } else {
              this._log("warn", `Bot用户 ${uid} 重试订阅失败 (API返回false)`);
            }
          } catch (error) {
            this._log("error", `Bot用户 ${uid} 重试订阅失败 (捕获异常): ${error.message}`);
          }
        } else {
          if (!hasAudioTrack) {
            this._log("debug", `Bot用户 ${uid} Agora SDK 音频轨道仍不可用 (hasAudio=${hasAudioTrack})`);
          } else if (isSubscribed) {
            this._log("info", `Bot用户 ${uid} 已经订阅，停止重试。`);
            this._clearBotSubscriptionRetry(uid); // 清理，以防万一
            return; // 已订阅，退出
          }
        }
      } else {
        this._log("warn", `Bot用户 ${uid} 在重试时已不在频道内，停止重试。`);
        this._clearBotSubscriptionRetry(uid); // 清理
        return; // 用户已离开，退出
      }

      // 如果未达到最大重试次数，安排下一次重试
      if (attempts < maxAttempts) {
        const timerId = setTimeout(retry, retryDelay);
        this.retryTimers.set(uid, timerId);
        this._log("debug", `为Bot用户 ${uid} 设置下次重试定时器 (ID: ${timerId})`);
      } else {
        this._log("error", `Bot用户 ${uid} 达到最大重试次数 (${maxAttempts})，放弃订阅。`);
        this._clearBotSubscriptionRetry(uid); // 清理
      }
    };

    // 立即执行第一次重试（或稍后执行，取决于 delay）
    // 给 Agora SDK 一点时间来同步状态，所以第一次也延迟一下
    const initialTimerId = setTimeout(retry, retryDelay);
    this.retryTimers.set(uid, initialTimerId);
    this._log("debug", `为Bot用户 ${uid} 启动初始重试定时器 (ID: ${initialTimerId})`);
  }

   /**
   * 新增：清除 Bot 用户的订阅重试任务
   * @param {string|number} uid - Bot 用户的 UID
   */
  _clearBotSubscriptionRetry(uid) {
    const timerId = this.retryTimers.get(uid);
    if (timerId) {
      clearTimeout(timerId);
      this.retryTimers.delete(uid);
      this._log("debug", `清除Bot用户 ${uid} 的重试定时器 (ID: ${timerId})`);
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
    const normalizedUID = normalizeUID(user.uid);
    const subscriptionInfo = this.subscriptions.get(normalizedUID);
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
   * 新增：检查频道内用户，对Bot用户启动重试（用于加入后立即检查）
   * 这个方法可以由外部调用，例如在 join 成功后
   */
  checkBotUsersForRetry() {
    this._log("info", "检查频道内所有Bot用户，启动可能的订阅重试...");
    const agoraUsers = this.client.remoteUsers;
    for (const agoraUser of agoraUsers) {
      if (agoraUser.hasAudio && window.WebUIDValidator?.isBotUser(agoraUser.uid)) {
        const normalizedUID = normalizeUID(agoraUser.uid);
        const subscriptionInfo = this.subscriptions.get(normalizedUID);
        const isSubscribed = this._isAlreadySubscribed(agoraUser.uid, "audio");
        // 如果 Bot 用户存在、有音频、但本地未订阅，则启动重试
        if (!isSubscribed) {
          this._log("info", `检测到未订阅的Bot用户 ${agoraUser.uid}，启动重试机制...`);
          this._scheduleBotSubscriptionRetry(agoraUser.uid, "audio");
        } else {
          this._log("debug", `Bot用户 ${agoraUser.uid} 已订阅或订阅信息存在，跳过。`);
        }
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

    // 只订阅音频流，避免视频订阅
    if (user.hasAudio) {
      subscriptionTypes.push("audio");
    }
    // 注释掉视频订阅以避免摄像头权限请求
    // if (user.hasVideo) {
    //   subscriptionTypes.push("video");
    // }

    if (subscriptionTypes.length > 0) {
      this._log("info", `自动订阅用户 ${user.uid} (仅音频)`, {
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
    const normalizedUID = normalizeUID(uid);
    let subscriptionInfo = this.subscriptions.get(normalizedUID);
    if (!subscriptionInfo) {
      // 兜底：用 SDK 当前远端列表补登记
      const userFromSDK = findRemoteUser(this.client, uid);
      if (userFromSDK) {
        this._updateSubscriptionInfo(uid, {
          user: userFromSDK,
          hasAudio: userFromSDK.hasAudio,
          hasVideo: userFromSDK.hasVideo,
          state: WebSubscriptionManager.SubscriptionState.NOT_SUBSCRIBED,
          joinedAt: new Date(),
        });
        subscriptionInfo = this.subscriptions.get(normalizeUID(uid));
        this._log("debug", `兜底登记用户 ${uid}（来自 client.remoteUsers）`);
      } else {
        this._log("error", `用户 ${uid} 不存在，无法订阅`);
        return false;
      }
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
    const normalizedUID = normalizeUID(uid);
    const subscriptionInfo = this.subscriptions.get(normalizedUID);
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
    const normalizedUID = normalizeUID(uid);
    const subscriptionInfo = this.subscriptions.get(normalizedUID);
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
    const normalizedUID = normalizeUID(uid);
    const existing = this.subscriptions.get(normalizedUID) || {};
    const updated = { ...existing, ...info, updatedAt: new Date() };
    this.subscriptions.set(normalizedUID, updated);
  }

  /**
   * 更新订阅状态
   */
  _updateSubscriptionState(uid, mediaType, state) {
    const normalizedUID = normalizeUID(uid);
    const subscriptionInfo = this.subscriptions.get(normalizedUID);
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
    const normalizedUID = normalizeUID(uid);
    const info = this.subscriptions.get(normalizedUID);
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

    this.client.off("user-joined", this._boundHandlers.userJoined);
    this.client.off("user-published", this._boundHandlers.userPublished);
    this.client.off("user-unpublished", this._boundHandlers.userUnpublished);
    this.client.off("user-left", this._boundHandlers.userLeft);
    this._boundHandlers = null;

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
