export function database(env) {
  if (!env?.DB) throw new Error("历史存储尚未就绪，请稍后重试");
  return env.DB;
}
