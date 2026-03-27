from services.store_connection import execute_query


def get_categories(store_id):
    return execute_query(
        store_id,
        "SELECT CategoryID, CategoryNo, CategoryName FROM Categories_tbl ORDER BY CategoryName",
    )


def get_subcategories(store_id, category_id):
    return execute_query(
        store_id,
        "SELECT SubCateID, SubCateName FROM SubCategories_tbl WHERE CategoryID = %s ORDER BY SubCateName",
        (category_id,),
    )


def get_all_subcategories(store_id):
    return execute_query(
        store_id,
        "SELECT s.SubCateID, s.SubCateName, s.CategoryID, c.CategoryName "
        "FROM SubCategories_tbl s "
        "JOIN Categories_tbl c ON s.CategoryID = c.CategoryID "
        "ORDER BY c.CategoryName, s.SubCateName",
    )


def get_taxes(store_id):
    return execute_query(
        store_id,
        "SELECT TaxID, TaxName, TaxDesc FROM ItemTaxes_tbl ORDER BY TaxName",
    )


def get_units(store_id):
    return execute_query(
        store_id,
        "SELECT UnitID, UnitDesc FROM Units_tbl ORDER BY UnitDesc",
    )


def get_manufacturers(store_id):
    return execute_query(
        store_id,
        "SELECT ManufacturerID, ManuName FROM Manufacturers_tbl ORDER BY ManuName",
    )


def get_promotions(store_id):
    return execute_query(
        store_id,
        "SELECT PromotionID, Name, PromotionDescription FROM Promotions_tbl WHERE Suspend = 0 OR Suspend IS NULL ORDER BY Name",
    )


def get_bin_locations(store_id):
    return execute_query(
        store_id,
        "SELECT DISTINCT BinLocationID FROM Items_BinLocations WHERE BinLocationID IS NOT NULL ORDER BY BinLocationID",
    )
