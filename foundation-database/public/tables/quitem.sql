select xt.add_column('quitem', 'quitem_listprice', 'NUMERIC(16,4)', NULL, 'public');

comment on column public.quitem.quitem_listprice is 'List price of Item.';
