{
  "variables": {
    "test_seam%": "0"
  },
  "targets": [
    {
      "target_name": "safe_write",
      "sources": ["src/safe_write.cc"],
      "include_dirs": [],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_VERSION=9"],
      "conditions": [
        [
          "test_seam==1",
          {
            "defines": ["SAFE_WRITE_TEST_SEAM=1"]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            }
          }
        ],
        [
          "OS=='linux'",
          {
            "cflags_cc": ["-std=c++20"]
          }
        ]
      ]
    }
  ]
}
