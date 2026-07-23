# VTuber 展开态 H5 设计约束

## 目标

- VTuber 行未展开时，只在右侧展开按钮外透曲目数和视频数。
- VTuber 行展开后，歌曲卡片在 H5 固定为一行两首，卡片等宽等高。
- 标题、歌手、次数和视频数全部靠左或按功能区对齐，不出现同页混合居中。
- 页码输入、选页按钮、上一页/下一页在同一视觉尺寸体系内。

## 行结构

```html
<article class="rank-row rank-row-vtuber">
  <div class="rank-number">01</div>
  <div class="rank-content">
    <a class="vtuber-display-link"><img class="vtuber-display-image" /></a>
    <div class="vtuber-title-line">
      <h2 class="rank-title vtuber-title">
        <a class="vtuber-title-link">频道名</a>
      </h2>
    </div>
    <div class="rank-subline">
      <div class="rank-meta-line">
        <span class="vtuber-collected-badge">已收录</span>
        <span class="subline-primary artist-song-preview">代表曲目 A、代表曲目 B</span>
      </div>
    </div>
  </div>
  <div class="rank-side">
    <div class="rank-count"><span class="rank-count-value">4695次</span></div>
    <button class="rank-expand">1029首<br />258视频</button>
  </div>
</article>
```

## 展开歌曲卡片

```css
.artist-song-drawer[data-source-mode="vtuber"] {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 74px;
  gap: 5px;
}

.artist-song-group-vtuber {
  height: 100%;
  overflow: hidden;
}
```

每张卡片只保留三块信息：缩略图、两行内歌名、一行内歌手、底部次数/视频数。长频道名、长歌名和长歌手都截断，不撑开网格行高。

## 分页

```css
.source-page-jump {
  grid-template-columns: 52px auto 52px;
}

.source-page-jump input {
  width: 52px;
}
```

来源/曲目分页只提供输入页码和“选页”，不使用下拉选页。
