export interface LoginBootstrap {
  needsClaim?: boolean;
  singleUser?: boolean;
  passwordSet?: boolean;
  remote?: boolean;
}

/** Copy-only helper used by the client login screen. Keep this module free of
 * repository and Node imports so the login bundle never pulls server storage in. */
export function remoteFirstSetupNotice(bootstrap: LoginBootstrap | null): { title: string; note: string } | null {
  if (bootstrap?.remote !== true) return null;
  if (bootstrap.singleUser === true && bootstrap.passwordSet === false) {
    return {
      title: "还没有设置访问密码",
      note:
        "为了不让别人抢先设置，第一次设访问密码只能在局域网里完成：在家里的网络打开这台机器的局域网地址" +
        "（例如 http://192.168.1.10:3000/login）设一个。设好之后就能从这里用密码登录。",
    };
  }
  if (bootstrap.singleUser !== true && bootstrap.needsClaim === true) {
    return {
      title: "这台实例还没有站主",
      note:
        "为了不让别人抢先认领，创建站主账号只能在局域网里完成：在家里的网络打开这台机器的局域网地址" +
        "（例如 http://192.168.1.10:3000/login）认领。之后家人朋友可以从这里注册自己的账号。",
    };
  }
  return null;
}
