# Stirling-PDF with extra OCR languages (Russian, Kyrgyz).
# Pin a specific version tag here instead of "latest" once it works.
FROM stirlingtools/stirling-pdf:latest

# The image's init script copies everything from /usr/share/tessdata
# into Tesseract's system tessdata directory on start.
ADD --chmod=644 https://github.com/tesseract-ocr/tessdata_fast/raw/main/rus.traineddata /usr/share/tessdata/rus.traineddata
ADD --chmod=644 https://github.com/tesseract-ocr/tessdata_fast/raw/main/kir.traineddata /usr/share/tessdata/kir.traineddata
