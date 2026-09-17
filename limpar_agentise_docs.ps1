# Troca "Agentise" por "AMAI Park" nos arquivos .md da raiz do projeto.
# Roda de dentro de C:\Users\Acer\Documents\Projetos\CRM

$arquivos = @('README.md', 'CLAUDE.md', 'INSTALL.md', 'CHANGELOG.md', 'ATUALIZACAO-AGOSTO-2026.md')

foreach ($f in $arquivos) {
    if (Test-Path $f) {
        $conteudo = Get-Content $f -Raw -Encoding UTF8
        $novo = $conteudo -creplace 'Agentise', 'AMAI Park' -creplace 'Mega CRM', 'AMAI Park CRM'
        if ($novo -ne $conteudo) {
            Set-Content $f -Value $novo -Encoding UTF8 -NoNewline
            Write-Host "Corrigido: $f"
        } else {
            Write-Host "Sem mudanca: $f"
        }
    } else {
        Write-Host "Nao encontrado: $f"
    }
}

Write-Host ""
Write-Host "Conferindo se sobrou algo..."
findstr /si agentise *.json *.md
