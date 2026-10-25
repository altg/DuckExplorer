import base64
import json
import threading
import time

import pytest


def outputs_of(response):
    assert response["error"] is None, response["error"]
    return response["outputs"]


def test_stdout_and_last_expression(kernel):
    outputs = outputs_of(kernel.execute_python("nb", "print('hello')\nprint('world')\n1 + 1"))
    assert outputs == [
        {"type": "stream", "name": "stdout", "text": "hello\nworld\n"},
        {"type": "text", "text": "2"},
    ]


def test_trailing_semicolon_suppresses_display(kernel):
    assert outputs_of(kernel.execute_python("nb", "1 + 1;")) == []


def test_namespace_persists_per_notebook(kernel):
    kernel.execute_python("a", "x = 10")
    assert outputs_of(kernel.execute_python("a", "x * 2")) == [{"type": "text", "text": "20"}]
    other = kernel.execute_python("b", "x")
    assert other["error"]["ename"] == "NameError"


def test_sql_result_is_available_as_dataframe(kernel):
    kernel.execute_sql("nb", "SELECT range AS n FROM range(5)")
    outputs = outputs_of(kernel.execute_python("nb", "print(type(df).__name__, int(df['n'].sum()))"))
    assert outputs[0]["text"] == "DataFrame 10\n"


def test_named_result(kernel):
    response = kernel.execute_sql("nb", "-- name: sales\nSELECT 'a' AS region, 3 AS total")
    assert response["outputs"][0]["table"]["boundTo"] == ["df", "sales"]
    outputs = outputs_of(kernel.execute_python("nb", "print(sales.loc[0, 'region'], df is sales)"))
    assert outputs[0]["text"] == "a True\n"


def test_rebound_name_is_not_overwritten(kernel):
    kernel.execute_sql("nb", "SELECT 1 AS n")
    kernel.execute_python("nb", "df = 'mine'")
    assert outputs_of(kernel.execute_python("nb", "df")) == [{"type": "text", "text": "'mine'"}]


def test_max_pandas_rows_caps_dataframe(kernel):
    kernel.max_pandas_rows = 10
    kernel.execute_sql("nb", "SELECT range AS n FROM range(100)")
    outputs = outputs_of(kernel.execute_python("nb", "len(df)"))
    assert outputs[0]["type"] == "stream" and "first 10 of 100 rows" in outputs[0]["text"]
    assert outputs[1] == {"type": "text", "text": "10"}


def test_sql_can_query_python_dataframes(kernel):
    kernel.execute_python("nb", "import pandas as pd\nprices = pd.DataFrame({'p': [1.5, 2.5]})")
    response = kernel.execute_sql("nb", "SELECT sum(p) AS total FROM prices")
    assert response["outputs"][0]["table"]["rows"] == [["4.0"]]
    # The sql() helper sees them too.
    outputs = outputs_of(kernel.execute_python("nb", "float(sql('SELECT max(p) AS m FROM prices')['m'][0])"))
    assert outputs == [{"type": "text", "text": "2.5"}]


def test_previous_sql_result_can_be_queried_in_sql(kernel):
    kernel.execute_sql("nb", "SELECT range AS n FROM range(10)")
    response = kernel.execute_sql("nb", "SELECT count(*) AS c FROM df")
    assert response["outputs"][0]["table"]["rows"] == [["10"]]


def test_dataframe_displays_as_table(kernel):
    outputs = outputs_of(
        kernel.execute_python(
            "nb", "import pandas as pd\npd.DataFrame({'a': [1, 2], 'b': ['x', None]}).set_index('a')"
        )
    )
    [output] = outputs
    assert output["type"] == "table"
    table = output["table"]
    assert [c["name"] for c in table["columns"]] == ["a", "b"]
    assert table["rows"] == [["1", "x"], ["2", None]]


def test_relation_displays_as_table_with_duckdb_types(kernel):
    [output] = outputs_of(kernel.execute_python("nb", "con.sql('SELECT 1::TINYINT AS t')"))
    assert output["table"]["columns"] == [{"name": "t", "type": "TINYINT"}]


def test_display_helper_keeps_order(kernel):
    outputs = outputs_of(kernel.execute_python("nb", "print('before')\ndisplay(42)\nprint('after')"))
    assert [o["type"] for o in outputs] == ["stream", "text", "stream"]


def test_matplotlib_figures_are_captured(kernel):
    code = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.title('t')"
    outputs = outputs_of(kernel.execute_python("nb", code))
    pngs = [o for o in outputs if o["type"] == "png"]
    assert len(pngs) == 1
    assert base64.b64decode(pngs[0]["data"]).startswith(b"\x89PNG")
    # Figures are closed after the cell, so the next cell starts clean.
    assert outputs_of(kernel.execute_python("nb", "len(plt.get_fignums())")) == [{"type": "text", "text": "0"}]


def test_plt_show_emits_in_place(kernel):
    code = "import matplotlib.pyplot as plt\nplt.plot([1])\nplt.show()\nprint('after')"
    outputs = outputs_of(kernel.execute_python("nb", code))
    assert [o["type"] for o in outputs] == ["png", "stream"]


def test_plotly_show_and_last_expression(kernel):
    pytest.importorskip("plotly")
    code = (
        "import plotly.graph_objects as go\n"
        "fig = go.Figure(go.Bar(x=['a', 'b'], y=[1, 2]))\n"
        "fig.show()\n"
        "fig"
    )
    outputs = outputs_of(kernel.execute_python("nb", code))
    assert [o["type"] for o in outputs] == ["plotly", "plotly"]
    figure = json.loads(outputs[0]["json"])
    assert figure["data"][0]["type"] == "bar"


def test_plotly_follows_theme(kernel):
    pytest.importorskip("plotly")
    kernel.configure({"theme": "dark"})
    code = "import plotly.express as px\npx.bar(x=['a'], y=[1])"
    [output] = outputs_of(kernel.execute_python("nb", code))
    template = json.loads(output["json"])["layout"]["template"]
    assert template["layout"]["paper_bgcolor"] == "rgb(17,17,17)"


def test_python_error_traceback_shows_user_frames(kernel):
    response = kernel.execute_python("nb", "def f():\n    return 1 / 0\nf()")
    error = response["error"]
    assert error["ename"] == "ZeroDivisionError"
    assert "<cell-" in error["traceback"]
    assert "return 1 / 0" in error["traceback"]
    assert "duckexplorer_kernel" not in error["traceback"]


def test_syntax_error(kernel):
    error = kernel.execute_python("nb", "def broken(:\n  pass")["error"]
    assert error["ename"] == "SyntaxError"


def test_output_before_error_is_kept(kernel):
    response = kernel.execute_python("nb", "print('partial')\nraise ValueError('boom')")
    assert response["outputs"] == [{"type": "stream", "name": "stdout", "text": "partial\n"}]
    assert response["error"]["evalue"] == "boom"


def test_interrupt_python_loop(kernel):
    def stop_soon():
        time.sleep(0.5)
        assert kernel.interrupt()

    threading.Thread(target=stop_soon).start()
    response = kernel.execute_python("nb", "while True:\n    pass")
    assert response["error"]["ename"] == "KeyboardInterrupt"
    assert outputs_of(kernel.execute_python("nb", "'still alive'")) == [{"type": "text", "text": "'still alive'"}]


def test_exit_does_not_kill_kernel(kernel):
    response = kernel.execute_python("nb", "exit()")
    assert response["error"]["ename"] == "SystemExit"


def test_decimals_become_floats_like_duckdb_df(kernel):
    kernel.execute_sql("nb", "SELECT 1.25::DECIMAL(10, 2) AS price, 1 AS a, 2 AS a")
    outputs = outputs_of(kernel.execute_python("nb", "print(df['price'].dtype, list(df.columns))"))
    assert outputs[0]["text"] == "float64 ['price', 'a', 'a']\n"
