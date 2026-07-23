#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), dev, not(test)))]
compile_error!(
    "Raw `cargo build --release` creates a dev-server executable. Use `npm run build:release`."
);

fn main() {
    hermes_ask_lib::run();
}
