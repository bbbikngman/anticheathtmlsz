/**
 * 声网UID类型验证和兼容性检查 - Web端
 * 基于声网技术支持的专业建议实现
 */

class WebUIDValidator {
  /**
   * 默认Bot UID（与Python端保持一致）
   */
  static DEFAULT_BOT_UID = 12345;

  /**
   * 检查是否为Bot用户
   * 支持整数和字符串UID的兼容性检查
   *
   * @param {any} uid - 待检查的UID
   * @returns {boolean} 是否为Bot用户
   */
  static isBotUser(uid) {
    try {
      // 优先检查整数UID（Python端使用整数）
      if (typeof uid === "number") {
        return uid === this.DEFAULT_BOT_UID;
      }

      // 兼容字符串UID
      if (typeof uid === "string") {
        try {
          const uidInt = parseInt(uid, 10);
          return !isNaN(uidInt) && uidInt === this.DEFAULT_BOT_UID;
        } catch (error) {
          console.warn("[UID_VALIDATOR] 字符串UID转换失败:", uid, error);
          return false;
        }
      }

      // 其他类型不支持
      console.warn("[UID_VALIDATOR] 不支持的UID类型:", typeof uid, uid);
      return false;
    } catch (error) {
      console.error("[UID_VALIDATOR] Bot用户检查异常:", error);
      return false;
    }
  }

  /**
   * 验证Web SDK UID兼容性
   * Web SDK支持字符串和整数UID（字符串UID支持）
   *
   * @param {any} uid - 待验证的UID
   * @returns {boolean} 是否兼容
   */
  static isValidWebSDKUID(uid) {
    try {
      // 检查基本类型
      if (typeof uid !== "number" && typeof uid !== "string") {
        return false;
      }

      // 字符串UID支持 - 直接接受非空字符串
      if (typeof uid === "string") {
        // 字符串UID只需要非空即可（支持如 "user_1758595626139" 格式）
        return uid.length > 0 && uid.trim().length > 0;
      }

      // 数字UID需要范围检查
      if (typeof uid === "number") {
        // 检查UID范围（声网UID范围：1 到 2^32-1）
        return uid >= 1 && uid <= Math.pow(2, 32) - 1;
      }

      return false;
    } catch (error) {
      console.error("[UID_VALIDATOR] Web SDK UID验证异常:", error);
      return false;
    }
  }

  /**
   * 标准化UID比较
   * 确保不同类型的UID能够正确比较
   *
   * @param {any} uid1 - 第一个UID
   * @param {any} uid2 - 第二个UID
   * @returns {boolean} 是否相等
   */
  static compareUIDs(uid1, uid2) {
    try {
      // 如果类型相同，直接比较
      if (typeof uid1 === typeof uid2) {
        return uid1 === uid2;
      }

      // 类型不同，转换为数字比较
      const num1 = typeof uid1 === "number" ? uid1 : parseInt(uid1, 10);
      const num2 = typeof uid2 === "number" ? uid2 : parseInt(uid2, 10);

      // 检查转换是否成功
      if (isNaN(num1) || isNaN(num2)) {
        return false;
      }

      return num1 === num2;
    } catch (error) {
      console.error("[UID_VALIDATOR] UID比较异常:", error);
      return false;
    }
  }

  /**
   * 获取默认Bot UID
   *
   * @returns {number} 默认Bot UID
   */
  static getDefaultBotUID() {
    return this.DEFAULT_BOT_UID;
  }

  /**
   * 验证配置中的UID设置
   *
   * @param {Object} config - 包含UID配置的对象
   * @returns {Object} 验证结果
   */
  static validateConfiguration(config) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      config: { ...config },
    };

    try {
      // 检查botUid
      if ("botUid" in config) {
        if (!this.isValidWebSDKUID(config.botUid)) {
          result.errors.push(`无效的botUid: ${config.botUid}`);
          result.isValid = false;
        } else {
          // 检查是否为预期的Bot UID
          if (!this.isBotUser(config.botUid)) {
            result.warnings.push(
              `botUid不是预期的Bot UID: ${config.botUid} (预期: ${this.DEFAULT_BOT_UID})`
            );
          }
        }
      }

      // 检查uid
      if ("uid" in config) {
        if (!this.isValidWebSDKUID(config.uid)) {
          result.errors.push(`无效的uid: ${config.uid}`);
          result.isValid = false;
        }
      }
    } catch (error) {
      result.errors.push(`配置验证异常: ${error.message}`);
      result.isValid = false;
    }

    return result;
  }

  /**
   * 记录UID相关的调试信息
   *
   * @param {string} context - 上下文信息
   * @param {any} uid - UID值
   * @param {Object} additionalInfo - 额外信息
   */
  static logUIDInfo(context, uid, additionalInfo = {}) {
    console.log(`[UID_VALIDATOR] ${context}:`, {
      uid: uid,
      type: typeof uid,
      isBot: this.isBotUser(uid),
      isValid: this.isValidWebSDKUID(uid),
      ...additionalInfo,
    });
  }
}

// 便捷函数
function isBotUser(uid) {
  return WebUIDValidator.isBotUser(uid);
}

function isValidUID(uid) {
  return WebUIDValidator.isValidWebSDKUID(uid);
}

function compareUIDs(uid1, uid2) {
  return WebUIDValidator.compareUIDs(uid1, uid2);
}

// 导出（如果在模块环境中）
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    WebUIDValidator,
    isBotUser,
    isValidUID,
    compareUIDs,
  };
}

// 全局暴露（如果在浏览器环境中）
if (typeof window !== "undefined") {
  window.WebUIDValidator = WebUIDValidator;
  window.isBotUser = isBotUser;
  window.isValidUID = isValidUID;
  window.compareUIDs = compareUIDs;
}
