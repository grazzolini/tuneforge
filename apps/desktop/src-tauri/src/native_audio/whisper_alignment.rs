#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DtwTokenBoundary {
    pub(crate) start_centiseconds: i64,
    pub(crate) end_centiseconds: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct AlignedTextToken {
    pub(crate) text: Vec<u8>,
    pub(crate) start_centiseconds: i64,
    pub(crate) end_centiseconds: i64,
    pub(crate) confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AlignedWord {
    pub(crate) text: String,
    pub(crate) start_centiseconds: i64,
    pub(crate) end_centiseconds: i64,
    pub(crate) confidence: f64,
    pub(crate) token_count: usize,
}

pub(crate) fn split_aligned_words(
    tokens: &[AlignedTextToken],
    language: Option<&str>,
) -> Result<Vec<AlignedWord>, &'static str> {
    let split_on_unicode = language
        .is_some_and(|language| matches!(language, "zh" | "ja" | "th" | "lo" | "my" | "yue"));
    let mut subwords = Vec::<(Vec<u8>, i64, i64, Vec<f64>, usize)>::new();
    let mut pending = None::<(Vec<u8>, i64, i64, Vec<f64>, usize)>;
    for token in tokens {
        let value = pending.get_or_insert_with(|| {
            (
                Vec::new(),
                token.start_centiseconds,
                token.end_centiseconds,
                Vec::new(),
                0,
            )
        });
        value.0.extend_from_slice(&token.text);
        value.2 = token.end_centiseconds;
        value.3.push(token.confidence);
        value.4 += 1;
        if std::str::from_utf8(&value.0).is_ok() {
            subwords.push(pending.take().unwrap());
        }
    }
    if pending.is_some() {
        return Err("Whisper returned an invalid UTF-8 word boundary.");
    }

    let mut grouped = Vec::<(Vec<u8>, i64, i64, Vec<f64>, usize)>::new();
    for subword in subwords {
        let text = std::str::from_utf8(&subword.0)
            .map_err(|_| "Whisper returned an invalid UTF-8 word boundary.")?;
        const ASCII_PUNCTUATION: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
        let stripped = text.trim();
        let punctuation = !stripped.is_empty() && ASCII_PUNCTUATION.contains(stripped);
        if split_on_unicode || text.starts_with(' ') || punctuation || grouped.is_empty() {
            grouped.push(subword);
        } else {
            let word = grouped.last_mut().unwrap();
            word.0.extend_from_slice(&subword.0);
            word.2 = subword.2;
            word.3.extend(subword.3);
            word.4 += subword.4;
        }
    }

    let mut words = grouped
        .into_iter()
        .map(|(bytes, start, end, probabilities, token_count)| {
            let text = String::from_utf8(bytes)
                .map_err(|_| "Whisper returned an invalid UTF-8 word boundary.")?;
            let confidence = probabilities.iter().sum::<f64>() / probabilities.len() as f64;
            Ok(AlignedWord {
                text,
                start_centiseconds: start,
                end_centiseconds: end,
                confidence,
                token_count,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    merge_punctuation(&mut words);
    for word in &mut words {
        word.text = word.text.trim().to_string();
    }
    words.retain(|word| !word.text.is_empty());
    Ok(words)
}

pub(crate) fn partition_aligned_words(
    words: Vec<AlignedWord>,
    segment_token_counts: &[usize],
) -> Result<Vec<Vec<AlignedWord>>, &'static str> {
    if words.iter().map(|word| word.token_count).sum::<usize>()
        != segment_token_counts.iter().sum::<usize>()
    {
        return Err("Whisper word timing did not cover every text token.");
    }

    let mut words = words.into_iter();
    let mut pending = words.next();
    let mut partitions = Vec::with_capacity(segment_token_counts.len());
    for &token_budget in segment_token_counts {
        let mut saved_tokens = 0;
        let mut partition = Vec::new();
        while saved_tokens < token_budget {
            let Some(word) = pending.take() else {
                break;
            };
            saved_tokens += word.token_count;
            partition.push(word);
            pending = words.next();
        }
        partitions.push(partition);
    }
    if pending.is_some() || words.next().is_some() {
        return Err("Whisper word timing did not match the transcript segments.");
    }
    Ok(partitions)
}

fn merge_punctuation(words: &mut Vec<AlignedWord>) {
    const PREPEND: &str = "'\"“¿([{-";
    const APPEND: &str = "'\".。,，!！?？:：”)]}、";
    let mut index = words.len();
    while index > 1 {
        index -= 1;
        if words[index - 1].text.starts_with(' ') && PREPEND.contains(words[index - 1].text.trim())
        {
            let prefix = words.remove(index - 1);
            words[index - 1].token_count += prefix.token_count;
            words[index - 1].text = format!("{}{}", prefix.text, words[index - 1].text);
        }
    }
    let mut index = 1;
    while index < words.len() {
        if !words[index - 1].text.ends_with(' ') && APPEND.contains(words[index].text.as_str()) {
            let suffix = words.remove(index);
            let previous = &mut words[index - 1];
            previous.token_count += suffix.token_count;
            previous.text.push_str(&suffix.text);
        } else {
            index += 1;
        }
    }
}

pub(crate) fn validate_complete_dtw_boundaries(
    boundaries: &[DtwTokenBoundary],
) -> Result<(), &'static str> {
    let mut previous_end = None;
    for boundary in boundaries {
        if boundary.start_centiseconds < 0
            || boundary.end_centiseconds < boundary.start_centiseconds
        {
            return Err("Whisper returned an incomplete DTW boundary sequence.");
        }
        if previous_end.is_some_and(|end| end != boundary.start_centiseconds) {
            return Err("Whisper returned a discontinuous DTW boundary sequence.");
        }
        previous_end = Some(boundary.end_centiseconds);
    }
    Ok(())
}

pub(crate) fn validate_aligned_word_boundaries(words: &[AlignedWord]) -> Result<(), &'static str> {
    let mut previous_end = None;
    for word in words {
        if word.token_count == 0
            || word.start_centiseconds < 0
            || word.end_centiseconds < word.start_centiseconds
        {
            return Err("Whisper returned an incomplete DTW boundary sequence.");
        }
        if previous_end.is_some_and(|end| word.start_centiseconds < end) {
            return Err("Whisper returned a discontinuous DTW boundary sequence.");
        }
        previous_end = Some(word.end_centiseconds);
    }
    Ok(())
}

pub(crate) fn validate_aligned_token_coverage(
    tokens: &[AlignedTextToken],
    expected_token_count: usize,
    segment_text: &[u8],
) -> Result<(), &'static str> {
    if tokens.len() != expected_token_count {
        return Err("Whisper returned an incomplete DTW boundary sequence.");
    }
    let reconstructed = tokens
        .iter()
        .flat_map(|token| token.text.iter().copied())
        .collect::<Vec<_>>();
    if trim_ascii_whitespace(&reconstructed) != trim_ascii_whitespace(segment_text) {
        return Err("Whisper DTW tokens did not cover the complete segment text.");
    }
    Ok(())
}

fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_terminal_boundary_for_every_text_token() {
        let jump_times = [12, 18, 31];
        let boundaries = jump_times
            .windows(2)
            .map(|pair| DtwTokenBoundary {
                start_centiseconds: pair[0],
                end_centiseconds: pair[1],
            })
            .collect::<Vec<_>>();

        assert_eq!(boundaries.len() + 1, jump_times.len());
        assert_eq!(boundaries.last().unwrap().end_centiseconds, 31);
        assert_eq!(validate_complete_dtw_boundaries(&boundaries), Ok(()));
    }

    #[test]
    fn rejects_missing_terminal_boundary() {
        let boundaries = vec![
            DtwTokenBoundary {
                start_centiseconds: 12,
                end_centiseconds: 18,
            },
            DtwTokenBoundary {
                start_centiseconds: 18,
                end_centiseconds: -1,
            },
        ];

        assert_eq!(
            validate_complete_dtw_boundaries(&boundaries),
            Err("Whisper returned an incomplete DTW boundary sequence.")
        );
    }

    #[test]
    fn rejects_missing_middle_token_even_when_remaining_boundaries_are_contiguous() {
        let tokens = vec![
            AlignedTextToken {
                text: b" first".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 5,
                confidence: 0.9,
            },
            AlignedTextToken {
                text: b" third".to_vec(),
                start_centiseconds: 5,
                end_centiseconds: 10,
                confidence: 0.8,
            },
        ];

        let boundaries = tokens
            .iter()
            .map(|token| DtwTokenBoundary {
                start_centiseconds: token.start_centiseconds,
                end_centiseconds: token.end_centiseconds,
            })
            .collect::<Vec<_>>();
        assert_eq!(validate_complete_dtw_boundaries(&boundaries), Ok(()));
        assert_eq!(
            validate_aligned_token_coverage(&tokens, 3, b" first second third"),
            Err("Whisper returned an incomplete DTW boundary sequence.")
        );
    }

    #[test]
    fn accepts_final_word_bounds_after_multi_token_long_word_adjustment() {
        let tokens = vec![
            AlignedTextToken {
                text: b" long".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 100,
                confidence: 0.9,
            },
            AlignedTextToken {
                text: b"word".to_vec(),
                start_centiseconds: 100,
                end_centiseconds: 50,
                confidence: 0.8,
            },
        ];

        let words = split_aligned_words(&tokens, Some("en")).unwrap();

        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "longword");
        assert_eq!(words[0].token_count, 2);
        assert_eq!(
            (words[0].start_centiseconds, words[0].end_centiseconds),
            (0, 50)
        );
        assert_eq!(validate_aligned_word_boundaries(&words), Ok(()));
        assert!(partition_aligned_words(words, &[2]).is_ok());
    }

    #[test]
    fn rejects_final_single_token_reversed_or_missing_word_bounds() {
        let reversed = split_aligned_words(
            &[AlignedTextToken {
                text: b" bad".to_vec(),
                start_centiseconds: 100,
                end_centiseconds: 50,
                confidence: 0.5,
            }],
            Some("en"),
        )
        .unwrap();
        let missing = split_aligned_words(
            &[AlignedTextToken {
                text: b" missing".to_vec(),
                start_centiseconds: -1,
                end_centiseconds: -1,
                confidence: 0.5,
            }],
            Some("en"),
        )
        .unwrap();

        assert_eq!(
            validate_aligned_word_boundaries(&reversed),
            Err("Whisper returned an incomplete DTW boundary sequence.")
        );
        assert_eq!(
            validate_aligned_word_boundaries(&missing),
            Err("Whisper returned an incomplete DTW boundary sequence.")
        );
    }

    #[test]
    fn splits_unicode_words_and_merges_punctuation() {
        let tokens = vec![
            AlignedTextToken {
                text: " olá".as_bytes().to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 3,
                confidence: 0.8,
            },
            AlignedTextToken {
                text: " mundo".as_bytes().to_vec(),
                start_centiseconds: 3,
                end_centiseconds: 7,
                confidence: 0.9,
            },
            AlignedTextToken {
                text: "!".as_bytes().to_vec(),
                start_centiseconds: 7,
                end_centiseconds: 8,
                confidence: 0.7,
            },
        ];
        let words = split_aligned_words(&tokens, Some("pt")).unwrap();
        assert_eq!(
            words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            ["olá", "mundo!"]
        );
        assert_eq!(words[1].end_centiseconds, 7);
        assert_eq!(words[1].confidence, 0.9);
        assert_eq!(words[1].token_count, 2);
    }

    #[test]
    fn merges_spaced_opening_and_unspaced_closing_quotes_without_changing_lexical_timing() {
        let tokens = vec![
            AlignedTextToken {
                text: b" \"".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 1,
                confidence: 0.1,
            },
            AlignedTextToken {
                text: b" hello".to_vec(),
                start_centiseconds: 1,
                end_centiseconds: 5,
                confidence: 0.9,
            },
            AlignedTextToken {
                text: b"\"".to_vec(),
                start_centiseconds: 5,
                end_centiseconds: 6,
                confidence: 0.2,
            },
        ];

        let words = split_aligned_words(&tokens, Some("en")).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "\" hello\"");
        assert_eq!(
            (words[0].start_centiseconds, words[0].end_centiseconds),
            (1, 5)
        );
        assert_eq!(words[0].confidence, 0.9);
        assert_eq!(words[0].token_count, 3);
    }

    #[test]
    fn leaves_unspaced_opening_quote_separate() {
        let tokens = vec![
            AlignedTextToken {
                text: b"\"".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 1,
                confidence: 0.1,
            },
            AlignedTextToken {
                text: b" hello".to_vec(),
                start_centiseconds: 1,
                end_centiseconds: 5,
                confidence: 0.9,
            },
        ];

        let words = split_aligned_words(&tokens, Some("en")).unwrap();
        assert_eq!(
            words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            ["\"", "hello"]
        );
    }

    #[test]
    fn assigns_cross_segment_opening_punctuation_by_merged_token_budget() {
        let tokens = vec![
            AlignedTextToken {
                text: b" \"".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 1,
                confidence: 0.1,
            },
            AlignedTextToken {
                text: b" hello".to_vec(),
                start_centiseconds: 1,
                end_centiseconds: 5,
                confidence: 0.9,
            },
        ];

        let words = split_aligned_words(&tokens, Some("en")).unwrap();
        let partitions = partition_aligned_words(words, &[1, 1]).unwrap();

        assert_eq!(partitions.len(), 2);
        assert_eq!(partitions[0].len(), 1);
        assert_eq!(partitions[0][0].text, "\" hello");
        assert_eq!(partitions[0][0].token_count, 2);
        assert_eq!(
            (
                partitions[0][0].start_centiseconds,
                partitions[0][0].end_centiseconds,
            ),
            (1, 5)
        );
        assert_eq!(partitions[0][0].confidence, 0.9);
        assert!(partitions[1].is_empty());
    }

    #[test]
    fn newline_token_continues_the_current_word() {
        let tokens = vec![
            AlignedTextToken {
                text: b" hello".to_vec(),
                start_centiseconds: 0,
                end_centiseconds: 4,
                confidence: 0.9,
            },
            AlignedTextToken {
                text: b"\nworld".to_vec(),
                start_centiseconds: 4,
                end_centiseconds: 8,
                confidence: 0.7,
            },
        ];

        let words = split_aligned_words(&tokens, Some("en")).unwrap();

        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "hello\nworld");
        assert_eq!(words[0].token_count, 2);
        assert_eq!(
            (words[0].start_centiseconds, words[0].end_centiseconds),
            (0, 8)
        );
        assert_eq!(words[0].confidence, 0.8);
    }
}
