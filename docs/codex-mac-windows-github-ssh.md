# Codex Windows / Mac / GitHub SSH 复用说明

更新时间：2026-07-22 22:32:08 +08:00

本文记录当前 Windows 主机、Mac 构建机和 GitHub 账号级 SSH 的配置方式。只记录公钥、路径、命令和验证证据；不要把密码、私钥、token 写入本文或提交到仓库。

## 当前拓扑

- Windows 工作机：当前 Codex 所在机器。
- Mac 构建机：`be@192.168.1.13`，也可用别名 `daily-song-list-mac` 或 `mac-builder`。
- GitHub 账号：`Marica7731`。
- 仓库：`git@github.com:Marica7731/daily-song-list.git`。

## 当前已配置状态

### Windows 到 GitHub

- GitHub 账号级认证 key 标题：`Windows Codex daily-song-list auto`
- Windows 私钥路径：`C:\Users\终焉\.ssh\id_ed25519_daily_song_list_codex_win_auto`
- Windows 公钥路径：`C:\Users\终焉\.ssh\id_ed25519_daily_song_list_codex_win_auto.pub`
- Fingerprint：`SHA256:5wn/DA79WgNVlrWcq/I+TwHb3Da8Y+EYkgjmqL8rquY`
- Windows `~/.ssh/config` 已配置：

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile C:\Users\终焉\.ssh\id_ed25519_daily_song_list_codex_win_auto
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

- Git for Windows 已配置为使用 Windows OpenSSH，避免中文用户目录下 Git bundled SSH 读取 `known_hosts` 或 `config` 失败：

```powershell
git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe
```

### Windows 到 Mac

Windows 同一把自动化公钥已写入 Mac 的 `/Users/be/.ssh/authorized_keys`。

Windows `~/.ssh/config` 已配置：

```sshconfig
Host daily-song-list-mac mac-builder 192.168.1.13
  HostName 192.168.1.13
  User be
  IdentityFile C:\Users\终焉\.ssh\id_ed25519_daily_song_list_codex_win_auto
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

### Mac 到 GitHub

- GitHub 账号级认证 key 标题：`Mac Codex builder`
- Mac 私钥路径：`/Users/be/.ssh/id_ed25519_daily_song_list_codex`
- Mac repo：`/Users/be/daily-song-list`
- Mac repo `origin` 已切到 SSH：

```text
origin  git@github.com:Marica7731/daily-song-list.git (fetch) [blob:none]
origin  git@github.com:Marica7731/daily-song-list.git (push)
```

Mac `~/.ssh/config` 已配置：

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile /Users/be/.ssh/id_ed25519_daily_song_list_codex
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

## 常用验证命令

### Windows 验证 GitHub

GitHub SSH 认证成功时会返回 `successfully authenticated`，退出码通常是 `1`，这是 GitHub 不提供 shell 的正常行为。

```powershell
ssh -T git@github.com
git ls-remote git@github.com:Marica7731/daily-song-list.git refs/heads/main
git push --dry-run git@github.com:Marica7731/daily-song-list.git HEAD:refs/heads/codex/windows-ssh-permission-test
```

本次验证证据：

```text
ssh -T git@github.com
Hi Marica7731! You've successfully authenticated, but GitHub does not provide shell access.

git ls-remote git@github.com:Marica7731/daily-song-list.git refs/heads/main
b6123e8ed54ecd0355893e2cce6cb87829023563  refs/heads/main

git push --dry-run git@github.com:Marica7731/daily-song-list.git HEAD:refs/heads/codex/windows-ssh-permission-test
* [new branch] HEAD -> codex/windows-ssh-permission-test
```

### Windows 验证 Mac 免密

```powershell
ssh 192.168.1.13 uname -a
ssh daily-song-list-mac pwd
```

本次验证证据：

```text
ssh 192.168.1.13 uname -a
Darwin bedeMacBook-Air.local 25.4.0 Darwin Kernel Version 25.4.0: Thu Mar 19 19:33:43 PDT 2026; root:xnu-12377.101.15~1/RELEASE_ARM64_T8142 arm64

ssh daily-song-list-mac pwd
/Users/be
```

### Mac 验证 GitHub

```sh
ssh daily-song-list-mac
source ~/.daily-song-list-build-env
cd ~/daily-song-list
ssh -T git@github.com
git ls-remote origin refs/heads/main
git push --dry-run origin HEAD:refs/heads/codex/mac-ssh-permission-test
```

本次验证证据：

```text
ssh -T git@github.com
Hi Marica7731! You've successfully authenticated, but GitHub does not provide shell access.

git ls-remote origin refs/heads/main
b6123e8ed54ecd0355893e2cce6cb87829023563  refs/heads/main

git push --dry-run origin HEAD:refs/heads/codex/mac-ssh-permission-test
* [new branch] HEAD -> codex/mac-ssh-permission-test
```

## daily-song-list 构建分工

### 推荐路径

当前最稳的分工是：

- Windows 负责代码编辑、差异审查、commit、push、线上发布收口。
- Windows 临时工作树和大日志优先放 `G:\`，不要放 `C:\`；`D:\` 空间不足时不要再继续塞大数据 checkout。
- Mac 负责干净 checkout 后的重型构建、SQLite/JSON 再生成和二次校验。

### Windows 本地收口

在 Windows 修改完成后，先在 G 盘工作树跑本地快速验证：

```powershell
cd G:\daily_song_list_data_clean_publish_20260722
npm run check
git diff --check
```

如果需要后台跑数据任务，日志放到 G 盘临时目录，例如：

```powershell
New-Item -ItemType Directory -Force G:\codex_tmp\daily-song-list-runlogs
```

临时 runner、日志、`.codex-tmp` 不能进 commit。

### Mac 干净复验

Windows commit 并 push 后，让 Mac 拉远端提交复验，避免 Mac 跑不到本地未提交 diff：

```powershell
ssh daily-song-list-mac "source ~/.daily-song-list-build-env && cd ~/daily-song-list && git fetch --depth=1 --filter=blob:none origin main && git checkout -B main FETCH_HEAD && PYTHON=python3 npm run test:db"
```

大 JSON / SQLite / runtime DB 类任务优先放 Mac 跑。需要全量构建时，先确认 Mac repo 的 sparse checkout 是否包含所需目录；如果只跑 DB 测试，当前 sparse checkout 足够。

## 从零重建步骤

### 1. Windows 生成自动化 key

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519_daily_song_list_codex_win_auto -N "" -C "daily-song-list-windows-codex-auto-YYYYMMDD"
```

### 2. 把 Windows key 加到 GitHub 账号

需要 `gh` 有 `admin:public_key` scope：

```powershell
gh auth refresh -h github.com -s admin:public_key
gh ssh-key add $env:USERPROFILE\.ssh\id_ed25519_daily_song_list_codex_win_auto.pub --title "Windows Codex daily-song-list auto" --type authentication
```

GitHub 网页手动添加时，密钥类型选择 **认证密钥**，不要选签名密钥。签名密钥只用于 commit/tag 签名，不能用于 `git pull/push`。

### 3. Windows Git 固定使用 Windows OpenSSH

```powershell
git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe
```

然后在 `C:\Users\终焉\.ssh\config` 添加 `github.com` 和 Mac 主机块，内容见上文。

### 4. Windows 公钥授权到 Mac

在 Windows 读取公钥：

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519_daily_song_list_codex_win_auto.pub
```

在 Mac 上执行：

```sh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' '粘贴 Windows 公钥整行' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

如果还没有免密，只能先用 Mac 本机终端操作，或从 Windows 用一次密码登录后写入。

### 5. Mac 生成并添加 GitHub key

在 Mac 上生成：

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_daily_song_list_codex -N "" -C "daily-song-list-mac-codex-YYYYMMDD"
cat ~/.ssh/id_ed25519_daily_song_list_codex.pub
```

把输出整行加到 GitHub 账号级 SSH key，密钥类型选 **认证密钥**。

Mac `~/.ssh/config` 添加 `github.com` 主机块，内容见上文。

## 常见问题

- `ssh -T git@github.com` 认证成功但退出码为 `1`：正常。GitHub 不提供 shell，只看输出是否包含 `successfully authenticated`。
- `gh ssh-key list` 提示缺 `admin:ssh_signing_key`：只是在查询签名 key 时缺 scope，和认证 key 添加、pull、push 无关。
- SSH 日志里出现 `Server accepts key` 后仍 `Permission denied`：通常是私钥带口令但当前环境不能输入，或 agent 没有签名。自动化场景建议重新生成 `-N ""` 的专用 key。
- Windows 的普通 `ssh` 成功，但 `git ls-remote git@github.com:...` 报 `Host key verification failed`：Git for Windows 可能走了 bundled SSH 并在中文用户目录下找错路径；执行 `git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe`。
- 任何时候都不要提交 `.ssh` 私钥、密码文件、token、cookie 或 GitHub 设备码。
