{{{row
## 元数据摘要
{{if .itemType}}- **类型**：{{.itemType}}
{{end}}{{if .authors}}- **作者**：{{range .authors}}{{.display}}{{if .separator}}{{.separator}}{{end}}{{end}}
{{end}}{{if .date}}- **日期**：{{.date}}
{{end}}{{if .journal}}- **期刊/书名**：{{.journal}}
{{end}}{{if .volume}}- **卷**：{{.volume}}
{{end}}{{if .issue}}- **期**：{{.issue}}
{{end}}{{if .pages}}- **页码**：{{.pages}}
{{end}}{{if .doi}}- **DOI**：[{{.doi}}](https://doi.org/{{.doi}})
{{end}}{{if .isbn}}- **ISBN**：{{.isbn}}
{{end}}{{if .issn}}- **ISSN**：{{.issn}}
{{end}}{{if .publisher}}- **出版社**：{{.publisher}}
{{end}}{{if .url}}- **来源**：[访问网页]({{.url}})
{{end}}{{if .tags}}- **标签**：{{range .tags}}{{.display}}{{if .separator}}{{.separator}}{{end}}{{end}}
{{end}}
{{if .abstract}}## 摘要
{{.abstract}}
{{end}}
{{if .attachments}}## 附件
{{range .attachments}}- [{{.title}}]({{.url}})
{{end}}{{end}}
{{if .hasTranslation}}## 翻译版本
{{if .translationMono}}- [单语翻译版]({{.translationMono}})
{{end}}{{if .translationDual}}- [双语对照版]({{.translationDual}})
{{end}}{{end}}
}}}
{: custom-section="meta"}
