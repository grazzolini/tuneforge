#![cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]

use std::ffi::{c_double, c_float, c_int};

unsafe extern "C" {
    fn tuneforge_soxr_resample_f32(
        input: *const c_float,
        input_length: usize,
        input_rate: c_double,
        output_rate: c_double,
        output: *mut c_float,
        output_capacity: usize,
        output_length: *mut usize,
    ) -> c_int;
}

pub fn resample_hq(samples: &[f32], input_rate: u32, output_rate: u32) -> Result<Vec<f32>, String> {
    let expected = super::decode::checked_analysis_output_len(samples.len(), input_rate, output_rate)?;
    let mut output = Vec::new();
    output.try_reserve_exact(expected).map_err(|_| "Audio analysis resampling allocation failed.".to_string())?;
    if samples.is_empty() || input_rate == output_rate {
        output.extend_from_slice(samples);
        return Ok(output);
    }
    output.resize(expected, 0.0_f32);
    let mut produced = 0_usize;
    let status = unsafe {
        tuneforge_soxr_resample_f32(
            samples.as_ptr(),
            samples.len(),
            f64::from(input_rate),
            f64::from(output_rate),
            output.as_mut_ptr(),
            output.len(),
            &mut produced,
        )
    };
    if status != 0 || produced > output.len() {
        return Err("Audio analysis resampling failed.".to_string());
    }
    output.truncate(produced);
    output.resize(expected, 0.0);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hq_resampling_matches_desktop_length_and_samples() {
        let input = (0..8_000)
            .map(|index| (2.0 * std::f32::consts::PI * 440.0 * index as f32 / 8_000.0).sin())
            .collect::<Vec<_>>();
        let output = resample_hq(&input, 8_000, 44_100).unwrap();
        assert_eq!(output.len(), 44_100);
        let expected = [0.006657809, 0.040168017, -0.013117433, -0.04225093];
        for (index, expected) in [0, 1, 100, 44_099].into_iter().zip(expected) {
            assert!(
                (output[index] - expected).abs() <= 1.0e-6,
                "output[{index}]={} != {expected}",
                output[index]
            );
        }
    }
    #[test]
    fn analysis_resamplers_reject_expansion_before_allocation() {
        for (input_rate, output_rate) in [(1, 48_000), (4_000, 44_100), (0, 48_000)] {
            assert!(resample_hq(&[0.0; 8], input_rate, output_rate).is_err());
            assert!(super::super::decode::resample_mono(&[0.0; 8], input_rate, output_rate).is_err());
        }
        assert!(super::super::decode::checked_analysis_output_len(usize::MAX, 1, 8).is_err());
        assert_eq!(resample_hq(&[0.0; 8], 1, 2).unwrap().len(), 16);
        assert_eq!(super::super::decode::resample_mono(&[0.0; 8], 1, 2).unwrap().len(), 16);
    }

}
