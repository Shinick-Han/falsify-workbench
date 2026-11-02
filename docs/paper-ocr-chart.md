# 논문 OCR·그래프 읽기

BLUE의 **자동 실행·도구 설정 → 스캔·그래프 읽기**에서 사용합니다. PC companion 연결이 필요합니다.

1. PDF를 넣습니다. 텍스트가 없는 스캔 PDF도 열 수 있습니다.
2. 쪽을 골라 **글자 읽기 (OCR)**를 누릅니다. 영어·한국어를 선택할 수 있습니다. 판독문과 표의 행·열·병합 셀을 준비합니다.
3. 그래프는 미리보기에서 축과 범례를 포함해 한 영역을 드래그하고 **그래프를 표로 읽기**를 누릅니다.
4. 원본과 결과를 대조합니다. JSON·CSV로 받거나 그대로 BLUE 검토를 진행합니다.

OCR은 현재 쪽 전체를 읽습니다. 그래프는 선택한 영역을 읽습니다. 원본 PDF·편집본은 바꾸지 않습니다. 생성 데이터는 원본 파일 해시·쪽·영역·입력 이미지 해시·엔진/모델에 연결되며 companion 메모리에 임시 보관됩니다. 전체 문서 OCR을 자동 시작하지 않습니다.

## 설치

개발 소스에서 한 번 실행합니다. 일반 companion 의존성과 모델 실행 환경은 분리됩니다.

```sh
python app/local/setup-paper-analysis.py
```

별도 가상환경에 RapidOCR 3.10.0, img2table 2.0.0, OpenCV contrib, Transformers·PyTorch를 설치하고 공개 DePlot 모델을 받습니다. 첫 OCR 실행 시 선택 언어의 공개 모델을 받습니다. 모델 파일은 Git에 넣지 않습니다. API 키는 필요하지 않습니다. 설치에는 네트워크와 디스크 공간이 필요합니다. PyTorch 설치 종류에 따라 CPU 또는 CUDA를 사용합니다.

분석은 요청할 때 자식 프로세스에서 실행합니다. 같은 companion 안에서 모델 프로세스를 겹쳐 띄우지 않으며, 완료·취소 시 종료합니다. Windows 명령 창을 띄우지 않습니다. 입력 PDF를 외부 변환 API에 보내지 않습니다. DePlot 추론은 내려받은 모델과 앱에 포함된 Liberation Sans를 사용하며 오프라인으로 실행합니다.

## 에이전트 MCP

기존 네 도구를 유지합니다. 모델 도구는 `--analysis`로 추가합니다.

```sh
python app/local/paper_mcp.py --pdf /absolute/path/paper.pdf --analysis
```

`initialize.instructions`에서 바인딩된 `paperId`와 파일 해시를 읽습니다. 추가 도구는 `list_analyses`, `read_analysis`, `ocr_page`, `extract_chart`, `digitize_points`입니다. 도구로 다른 파일이나 URL을 열 수 없습니다. OCR·그래프 결과는 native PDF 셀과 별도로 저장됩니다.

`ocr_page`는 쪽·영역·언어를 지정합니다. 여러 쪽은 에이전트가 필요한 쪽을 순서대로 호출합니다. `extract_chart`는 원본 영역 이미지를 DePlot 표로 바꿉니다. 값은 모델 추정이며 정확도가 검증된 원시 데이터가 아닙니다.

로그 축처럼 모델의 읽기가 틀리기 쉬운 그래프는 `render_region`으로 원본을 보고 `digitize_points`로 보정할 수 있습니다. 이 도구는 각 축의 눈금 두 개와 점을 이미지 픽셀로 받아 계산합니다.

```json
{
  "paperId": "initialize에서 받은 값",
  "pageIndex": 0,
  "imageSha256": "render_region의 sha256",
  "bbox": [0, 0, 300, 300],
  "dpi": 120,
  "calibration": {
    "x": {"scale": "linear", "points": [{"pixel": 100, "value": 1}, {"pixel": 400, "value": 4}]},
    "y": {"scale": "log", "points": [{"pixel": 400, "value": 10}, {"pixel": 100, "value": 1000}]}
  },
  "points": [[250, 250]]
}
```

이 예의 계산 결과는 `(2.5, 100)`입니다. 이미지의 왼쪽 위가 `(0,0)`이고 y는 아래로 증가합니다. `bbox`·`dpi`는 먼저 받은 원본 이미지와 같아야 합니다. 픽셀 반 칸에 따른 값 구간과 PDF 좌표도 남깁니다. 눈금·점·축 종류 선택의 정확성을 이 계산이 대신 검증하지는 않습니다.

## 확인한 범위

- 실제 영문 스캔 표: 10개 문자열·3×3 셀 복원. 저대비 이미지도 같은 결과.
- 90·180·270도 회전한 표에서도 같은 문자열·셀 순서를 복원하고 좌표는 원본 이미지로 되돌림.
- 실제 한국어: 문구와 숫자를 읽었으나 일부 띄어쓰기가 합쳐짐.
- 실제 막대 그래프: 24·48·36 복원. 선형 꺾은선: 10·20·40·80 복원.
- 같은 꺾은선을 로그 축으로 바꾸면 DePlot이 오독함. 자동 로그 축 수치 복원은 해결 완료로 보지 않음. 축을 지정하는 계산 경로를 별도로 제공함.

손글씨·복잡한 수식·중첩 패널·촘촘한 범례·다축 그래프·모든 논문의 OCR 정확도를 보장하지 않습니다. `ready`는 데이터 형식이 준비됐다는 뜻이며 정답 판정이 아닙니다. 모델 원문·판독문·원본 위치를 남겨 재검토할 수 있게 합니다.

사용한 구성: [RapidOCR](https://github.com/RapidAI/RapidOCR), [img2table](https://github.com/xavctn/img2table), [DePlot](https://huggingface.co/google/deplot). 축 보정은 [WebPlotDigitizer의 XY 보정 방식](https://www.automeris.io/docs/digitize/)과 같은 선형·로그 보간을 사용합니다. 별도 GUI 앱을 포크하지 않고 기존 MCP에 작은 계산 도구로 구성했습니다.
