## Instructions for Claude Code benchmark

Launch an isolated claude session using `run.sh {scenario}`
Scenario could be:
- `normal`: All the requests made by Claude are sent to Edgee (AI Gateway) 
- `edgee`: All the requests made by Claude are sent to Edgee (AI Gateway) with a token compression feature enabled
- `rtk`: RTK (rust token killer) is enabled locally, it's a bash proxy that overload main bash commands. Claude use RTK for bash tools and all the requests made by Claude are sent to Edgee (AI Gateway)

## Instructions for Claude Code when it's running

Put Claude Code in plan mode, give it an instruction, then execute the proposed plan. Repeat for each instruction.

---

### Instructions (to copy-paste one by one)

1. Add a `--json` option to the `edgee whoami` command to display user information in JSON instead of the current text format.

2. Improve the error message when the manifest is not found in `edgee components build`: suggest running `edgee components new` or `edgee components init`.

3. Add a unit test for the `parse_settings` function in `commands/components/test/mod.rs` that verifies the case of invalid settings (e.g., `key=without=value`). 

4. Documents the `proxy/tools/mod.rs` module with a description of the available tools (real_ip, edgee_cookie, crypto, cacheable).

5. Add a `--verbose` option to the `edgee components build` command to display the full output of the build command instead of hiding it.

6. Refactor the `get_root_domain` function in `proxy/tools/edgee_cookie.rs` to extract the TLD parsing logic into a separate function and document edge cases.

7. Add validation that the `.wasm` file referenced in a `data_collection` or `edge_function` component exists before starting the proxy with `edgee serve`.

8. Improve the error message of `decrypt` in `proxy/tools/crypto.rs` to distinguish between "Invalid hex" and "Failed to decrypt" with more explicit messages.

9. Add a `--dry-run` option to the `edgee components push` command that displays what would be sent without performing the upload.

10. Add unit tests for `check_cacheability` in `proxy/tools/cacheable.rs` with different HTTP request types.

11. Document the `Manifest` structure in `components/manifest.rs` with examples of valid edgee.yaml file.

12. Add a `--no-color` option to the `edgee` command (or via `NO_COLOR` environment variable) to disable output coloring.

13. Improves the feedback of `edgee components new`: displays the absolute path of the created directory at the end of the operation.

14. Add validation of URL format in the `documentation` and `repository` fields of the manifest at loading time.

15. Refactor the routing code in `proxy/server/context/routing.rs` to extract the rule matching logic into a dedicated function.

16. Add a help message when `edgee login` fails: indicate where to create a token (link to edgee.ai).

17. Add tests for `get_or_set` in `proxy/tools/edgee_cookie.rs` with mock requests (without cookie, with valid cookie, with expired cookie).

18. Document the `edgee components test` command in the main README with a complete example including `--event-type`, `--settings` and `--make-http-request`.

19. Add validation that the regexes in `path_regexp` of routing rules are compilable (via `regex::Regex::new`) when loading the edgee.toml config, instead of panicking at runtime.

20. Improves error display from the API in `edgee components push`: extracts and displays the server error message if available.

21. Add an `--output` option to `edgee components build` to specify the path of the generated .wasm file (instead of the current directory).

22. Add an integration test for `edgee components init` that verifies a valid manifest is created with the required fields.

23. Refactor `do_build` in `commands/components/build.rs` to capture and display stderr in case of build failure.

24. Add validation that the `aes_key` and `aes_iv` keys in the compute config have the expected length (16 bytes for AES-128) at proxy startup.

25. Documents the supported environment variables (EDGEE_API_PROFILE, etc.) in the README or an ENV.md file.

26. Add an `edgee version` command (or extend `edgee --version`) to display the CLI version as well as the wasmtime version being used.

27. Improves the parsing of redirects in the config: validates that `source` and `target` are valid paths or URLs.

28. Add tests for the `encrypt`/`decrypt` function in crypto.rs with strings containing Unicode characters.

29. Add a `--quiet` option to `edgee components build` to reduce verbosity (errors only).

30. Refactor the config loading logic in `config.rs` to return more structured errors with the file path and approximate line number in case of parsing failure.

31. Add a `--yes` or `--force` flag to `edgee components push` to skip interactive confirmation prompts when pushing.

32. Add a `--config` option to `edgee serve` to specify the path to the config file (edgee.toml or edgee.yaml) instead of using the current directory.

33. Add validation for the `wit_version` field in the manifest: reject unsupported versions with a clear error listing supported values (e.g. 1.0.0, 1.0.1 for data_collection).

34. Add a `--skip-build` option to `edgee components test` to run tests against an existing .wasm file without rebuilding.

35. Document the `proxy/server/compute` module with a description of the data collection and edge function execution flow.

36. Add unit tests for the `Realip` tool in `proxy/tools/real_ip.rs` with various `X-Forwarded-For` and `X-Real-IP` header combinations.

37. Add validation that component IDs in the config are unique across all `data_collection` and `edge_function` sections.

38. Add a `--validate-only` flag to `edgee serve` that loads and validates the config without starting the proxy server.

39. Add a `--clean` option to `edgee components build` that removes the target/output directory before building (similar to `cargo clean`).

40. Add tests for `set_user_cookie` and `get_user_cookie` in `proxy/tools/edgee_cookie.rs` with mock request/response handles.

41. Improve the error message when `edgee components new` fails to download sample code (network error, 404): suggest checking connectivity and the component name.

42. Add a `--format` option to `edgee components check` with values `human` (default) and `json` for machine-readable output.

43. Add documentation for the `Payload` structure in `proxy/server/compute/data_collection/payload.rs` with field descriptions.

44. Add support for the `EDGEE_LOG_LEVEL` environment variable to control proxy log verbosity (trace, debug, info, warn, error).

45. Add validation that `source` and `target` in redirections do not create redirect loops (e.g. A -> B and B -> A).

46. Add a `--timeout` option to `edgee components push` to set the HTTP request timeout for the upload (default 60s).

47. Refactor the `inquire` prompts in `edgee components new` to allow passing all options via CLI flags, making it fully non-interactive.

48. Add tests for the HTML rewriting logic in `proxy/server/compute/html.rs` with sample HTML input and expected output.

49. Add a `edgee config validate` subcommand that validates edgee.toml/edgee.yaml without starting the proxy.

50. Improve the `edgee generate-shell-completion` help text to show installation examples for each supported shell (bash, zsh, fish, etc.).
