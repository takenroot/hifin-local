// 只导出布局层自己的东西。命令面板住在 features/command-palette/，
// 由 AppLayout 直接引入，不从 layout 桶里再转一手（旧的转发导出无人使用）。
export { default as AppLayout } from './AppLayout';
