/**
 * dev-tools 插件业务错误码（-3001 起）。
 * 遵守分权：宿主仅用 -1xx~-2xx 段，插件专用 -3xxx 起。
 * handler 内 throw 时用 PluginError 包装，SDK wrapError 会保留 code/msg 组成失败信封。
 */
export const DevErr = {
  INVALID_ARG: -3001,
  PACKAGE_INVALID: -3002,
  BUILD_FAIL: -3003,
  NOT_FOUND: -3004,
  /** 上传/导入：未登录或登录过期 */
  AUTH_FAIL: -3005,
  /** 上传/导入：网络/服务端不可达 */
  NETWORK_FAIL: -3006,
  /** 上传：签名密钥注册失败 */
  SIGNATURE_FAIL: -3007,
  /** 上传：multipart 上传失败 */
  UPLOAD_FAIL: -3008,
  /** 导入本地：宿主安装失败 */
  INSTALL_LOCAL_FAIL: -3009,
  /** 打开/构建：未检测到 Node.js 运行环境 */
  NODEJS_MISSING: -3010,
  /** 创建：插件 ID 或名称与市场/本地已有插件重复 */
  DUPLICATE: -3011,
  /** 导入/新增：用户未授予目标目录的读/写权限 */
  PERMISSION_DENIED: -3012,
  /** 打包：用户取消保存（保存对话框关闭） */
  CANCELED: -3013,
} as const

export type DevErrCode = (typeof DevErr)[keyof typeof DevErr]
