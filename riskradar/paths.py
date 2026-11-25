"""Classify repository paths into the categories the features count.

The categories are deliberately coarse and decided from the path alone, because
the live API only sees paths (plus line counts) and must classify them exactly
as the offline pipeline did.
"""

from __future__ import annotations

import posixpath
import re

SOURCE = "source"
TEST = "test"
DOC = "doc"
CONFIG = "config"
DEPENDENCY = "dependency"
GENERATED = "generated"
OTHER = "other"

LANGUAGE_BY_EXT: dict[str, str] = {
    "py": "python", "pyi": "python", "pyx": "python", "pxd": "python",
    "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
    "ts": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
    "vue": "vue", "svelte": "svelte", "astro": "astro",
    "go": "go", "rs": "rust",
    "java": "java", "kt": "kotlin", "kts": "kotlin", "scala": "scala", "groovy": "groovy",
    "c": "c", "h": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp",
    "hxx": "cpp", "cu": "cuda", "cuh": "cuda", "m": "objc", "mm": "objc",
    "metal": "metal", "swift": "swift",
    "rb": "ruby", "php": "php", "cs": "csharp", "fs": "fsharp",
    "sh": "shell", "bash": "shell", "zsh": "shell", "fish": "shell", "ps1": "powershell",
    "lua": "lua", "sql": "sql", "ex": "elixir", "exs": "elixir", "erl": "erlang",
    "hs": "haskell", "ml": "ocaml", "dart": "dart", "r": "r", "jl": "julia",
    "zig": "zig", "nim": "nim", "nu": "nushell", "tcl": "tcl", "pl": "perl",
    "css": "css", "scss": "css", "sass": "css", "less": "css",
    "html": "html", "htm": "html", "jinja": "html", "j2": "html",
    "graphql": "graphql", "gql": "graphql", "proto": "protobuf", "wgsl": "shader",
    "glsl": "shader", "hlsl": "shader",
}

LOCKFILES = {
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "bun.lock", "poetry.lock", "uv.lock", "pdm.lock", "pipfile.lock", "cargo.lock", "go.sum",
    "gemfile.lock", "composer.lock", "flake.lock", "mix.lock", "pubspec.lock",
}
MANIFESTS = {
    "package.json", "pyproject.toml", "setup.py", "setup.cfg", "pipfile", "cargo.toml",
    "go.mod", "gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
    "pubspec.yaml", "mix.exs", "environment.yml", "vcpkg.json", "conanfile.txt",
}
_REQUIREMENTS = re.compile(r"^(requirements|constraints)([-_.][\w.-]+)?\.(txt|in)$")

_GENERATED = re.compile(
    r"(\.min\.(js|css)$|\.map$|_pb2(_grpc)?\.pyi?$|\.pb\.go$|\.pb\.(cc|h)$|\.generated\.\w+$"
    r"|(^|/)(dist|build|vendor|node_modules|third_party|thirdparty)/)"
)
_TEST_DIR = re.compile(
    r"(^|/)(tests?|__tests__|__snapshots__|spec|specs|testdata|test_data|testing|fixtures?"
    r"|e2e|integration[-_]tests?|unittests?)(/|$)"
)
_TEST_FILE = re.compile(
    r"(^test_.*\.py$|_test\.(py|go|rs|cc|cpp|c)$|\.(test|spec)\.[cm]?[jt]sx?$"
    r"|(Test|Tests|Spec)\.(java|kt|cs|scala|swift)$|^conftest\.py$|\.snap$)"
)
_DOC_DIR = re.compile(r"(^|/)(docs?|documentation|examples?|docs_src|site|website|blog)/")
_DOC_EXT = {"md", "mdx", "rst", "adoc", "txt", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf"}
_DOC_NAMES = {"license", "licence", "copying", "authors", "contributors", "notice", "changelog",
              "changes", "history", "news", "readme", "code_of_conduct", "security"}
_CONFIG_EXT = {"yml", "yaml", "toml", "ini", "cfg", "conf", "json", "jsonc", "json5",
               "properties", "env", "editorconfig", "xml", "plist"}
_CONFIG_NAMES = {"dockerfile", "makefile", "justfile", "procfile", "cmakelists.txt", "tox.ini",
                 "noxfile.py", ".gitignore", ".gitattributes", ".dockerignore", ".npmrc",
                 ".nvmrc", ".python-version", "rust-toolchain", "codeowners"}


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[1].lower() if "." in name else ""


def classify(path: str) -> str:
    """Return the single category a path belongs to (first match wins)."""
    lower = path.lower()
    name = posixpath.basename(path)
    lname = name.lower()
    ext = _ext(name)

    if lname in LOCKFILES:
        return DEPENDENCY
    if _GENERATED.search(lower):
        return GENERATED
    if _TEST_DIR.search(lower) or _TEST_FILE.search(name):
        return TEST
    if lname in MANIFESTS or _REQUIREMENTS.match(lname):
        return DEPENDENCY
    if (lower.startswith((".github/", ".circleci/", ".gitlab/", ".devcontainer/", ".vscode/"))
            or lname in _CONFIG_NAMES or lname.startswith(("dockerfile", ".eslintrc", ".prettierrc",
                                                           ".babelrc", "tsconfig", ".env"))
            or ext in _CONFIG_EXT):
        return CONFIG
    if _DOC_DIR.search(lower) or ext in _DOC_EXT or lname.split(".")[0] in _DOC_NAMES:
        return DOC
    if ext in LANGUAGE_BY_EXT:
        return SOURCE
    return OTHER


def language(path: str) -> str | None:
    return LANGUAGE_BY_EXT.get(_ext(posixpath.basename(path)))


def subsystem(path: str) -> str:
    """Top-level directory; root-level files all share the root subsystem ''."""
    head, sep, _ = path.partition("/")
    return head if sep else ""


def directory(path: str) -> str:
    return posixpath.dirname(path)


_COMMENT = re.compile(r"^\s*(#|//|/\*|\*|\*/|--|;|<!--|\"\"\"|''')")


def is_meaningful_line(text: str) -> bool:
    """False for blank and comment-only lines; SZZ ignores those when blaming."""
    stripped = text.strip()
    if not stripped or stripped in {"{", "}", "(", ")", "[", "]", "};", "});", "end", "pass"}:
        return False
    return not _COMMENT.match(stripped)
