# ERP 캡처 이미지 테두리 크롭 스크립트
#
# Node.js가 이 컴퓨터에 설치되어 있지 않아(npm install sharp 불가) 동일한 로직을
# PowerShell + .NET System.Drawing으로 구현했다. 알고리즘은 요청과 동일하다:
#   1. 이미지 가장자리에서 안쪽으로 스캔하며, 연한 회색(RGB 204,204,204 근사치) 픽셀이
#      이미지 폭/높이의 70% 이상 이어지는 첫 줄을 "가장 바깥 테두리"로 감지한다.
#   2. 그 테두리 선을 기준으로 바깥쪽 흰 여백만 잘라낸다(테두리 자체는 남기고,
#      테두리 안쪽의 세로/가로 구분선은 건드리지 않는다).
#
# 원본: 과제pt/사진  →  저장: accounting-wiki/assets/erp/ (파일명 유지)
# 이미 저장 경로에 있는 파일은 건너뛰고 새 파일만 처리한다.

Add-Type -AssemblyName System.Drawing

$SrcDir = "C:\Users\mdj11\OneDrive - 다우키움그룹\claude\과제pt\wiki\사진"
$DstDir = "C:\Users\mdj11\OneDrive - 다우키움그룹\claude\accounting-wiki\assets\erp"
$BorderRGB = 204      # 감지 대상 테두리 색
$Tolerance = 20        # ±허용치 — 실측 결과 우측 테두리 라인이 (210~218) 정도로 살짝 번져
                       # 있어(안티에일리어싱) 12는 너무 좁았다. 20으로 넓히고 전체 행/열을
                       # 다 스캔해야(2픽셀씩 건너뛰지 않고) 안정적으로 잡힌다.
$MatchRatio = 0.70     # 그 줄의 몇 %가 테두리색이어야 "테두리 선"으로 인정할지

function Test-BorderColor($pixel) {
    return ([Math]::Abs($pixel.R - $BorderRGB) -le $Tolerance) -and
           ([Math]::Abs($pixel.G - $BorderRGB) -le $Tolerance) -and
           ([Math]::Abs($pixel.B - $BorderRGB) -le $Tolerance)
}

function Find-OutermostBorder($bmp) {
    $w = $bmp.Width; $h = $bmp.Height

    # 위에서 아래로: 폭의 70% 이상이 테두리색인 첫 행 (경계선이 안티에일리어싱으로 살짝
    # 번지는 경우가 있어 모든 픽셀을 다 검사한다 — 2픽셀씩 건너뛰면 놓칠 수 있다)
    $top = 0
    for ($y = 0; $y -lt $h; $y++) {
        $hits = 0
        for ($x = 0; $x -lt $w; $x++) { if (Test-BorderColor $bmp.GetPixel($x, $y)) { $hits++ } }
        if (($hits / $w) -ge $MatchRatio) { $top = $y; break }
    }
    # 아래에서 위로
    $bottom = $h - 1
    for ($y = $h - 1; $y -ge 0; $y--) {
        $hits = 0
        for ($x = 0; $x -lt $w; $x++) { if (Test-BorderColor $bmp.GetPixel($x, $y)) { $hits++ } }
        if (($hits / $w) -ge $MatchRatio) { $bottom = $y; break }
    }
    # 왼쪽에서 오른쪽으로
    $left = 0
    for ($x = 0; $x -lt $w; $x++) {
        $hits = 0
        for ($y = 0; $y -lt $h; $y++) { if (Test-BorderColor $bmp.GetPixel($x, $y)) { $hits++ } }
        if (($hits / $h) -ge $MatchRatio) { $left = $x; break }
    }
    # 오른쪽에서 왼쪽으로
    $right = $w - 1
    for ($x = $w - 1; $x -ge 0; $x--) {
        $hits = 0
        for ($y = 0; $y -lt $h; $y++) { if (Test-BorderColor $bmp.GetPixel($x, $y)) { $hits++ } }
        if (($hits / $h) -ge $MatchRatio) { $right = $x; break }
    }
    return @{ Top = $top; Bottom = $bottom; Left = $left; Right = $right }
}

if (-not (Test-Path $DstDir)) { New-Item -ItemType Directory -Force $DstDir | Out-Null }

$files = Get-ChildItem -Path $SrcDir -Filter *.png -File
foreach ($f in $files) {
    $dstPath = Join-Path $DstDir $f.Name
    if (Test-Path $dstPath) {
        Write-Output "SKIP (already exists): $($f.Name)"
        continue
    }

    $bmp = New-Object System.Drawing.Bitmap($f.FullName)
    $b = Find-OutermostBorder $bmp

    $w2 = $b.Right - $b.Left + 1
    $h2 = $b.Bottom - $b.Top + 1
    if ($w2 -le 0 -or $h2 -le 0) {
        Write-Output "SKIP (no border detected): $($f.Name)"
        $bmp.Dispose()
        continue
    }

    $cropped = New-Object System.Drawing.Bitmap($w2, $h2)
    $g = [System.Drawing.Graphics]::FromImage($cropped)
    $srcRect = New-Object System.Drawing.Rectangle($b.Left, $b.Top, $w2, $h2)
    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $w2, $h2)
    $g.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bmp.Dispose()

    $cropped.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $cropped.Dispose()

    Write-Output "OK: $($f.Name)  border(T=$($b.Top) B=$($b.Bottom) L=$($b.Left) R=$($b.Right)) -> ${w2}x${h2}"
}

