// 发布构建不弹控制台窗口（GUI 应用调用控制台程序时的经典要求）。
// 注意：这个属性必须在 crate 根部，且只作用于 bin，不影响 lib。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    toolforge_lib::run()
}
