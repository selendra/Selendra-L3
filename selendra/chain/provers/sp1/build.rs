use sov_zkvm_utils::should_skip_guest_build;
use sp1_build::{build_program_with_args, BuildArgs};

fn main() {
    println!("cargo::rerun-if-env-changed=SKIP_GUEST_BUILD");
    println!("cargo::rerun-if-env-changed=OUT_DIR");

    if should_skip_guest_build("sp1") {
        println!("cargo:warning=Skipping SP1 guest build");
        return;
    }

    let features = sov_zkvm_utils::collect_features(&["bench"], &["native"]);

    let args = BuildArgs {
        features,
        ..Default::default()
    };

    build_program_with_args("./guest-mock", args.clone());
    build_program_with_args("./guest-celestia", args);
}
